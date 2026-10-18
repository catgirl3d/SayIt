// Shared HTTP client for all providers.
//
// Why User-Agent is mandatory: **reqwest sends no UA by default**, and nginx/WAF-style
// gateways commonly block requests without one as bot traffic. We verified this against
// https://test-ai-api.nwcdcloud.cn/v1 (a LiteLLM gateway): the same address, key, and model
// returned 200 with a UA, but consistently returned 403 with an nginx HTML error page without
// one. The gateway rejected the request before authentication ran. Our own ALB has the same
// rule (see pitfall 1). Those 403 responses do not mention User-Agent, so the failure is
// otherwise misclassified as "region unavailable / model not enabled" and changing the key
// or model cannot fix it.
//
// Therefore providers must not construct `reqwest::Client::new()` themselves; they must use
// the singleton here. Reusing it also preserves the connection pool and TLS sessions instead
// of rebuilding a client for every call.
pub const USER_AGENT: &str = concat!("SayIt/", env!("CARGO_PKG_VERSION"));

static SHARED: once_cell::sync::Lazy<reqwest::Client> = once_cell::sync::Lazy::new(|| {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        // Construction can fail only when the TLS backend cannot initialize. Falling back to
        // the default client is no worse than failing here; at minimum, do not make all
        // transcription unavailable because this configured client could not be built.
        .unwrap_or_else(|_| reqwest::Client::new())
});

static SHARED_NO_REDIRECT: once_cell::sync::Lazy<Result<reqwest::Client, String>> =
    once_cell::sync::Lazy::new(|| {
        reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| error.to_string())
    });

/// Shared client with User-Agent. Each call site still sets its own timeout with `.timeout()`.
pub fn shared() -> &'static reqwest::Client {
    &SHARED
}

/// Shared pooled client for providers that send credentials or audio, with
/// redirects disabled so the request cannot be replayed to another origin.
pub fn shared_no_redirect() -> Result<&'static reqwest::Client, &'static str> {
    match &*SHARED_NO_REDIRECT {
        Ok(client) => Ok(client),
        Err(error) => Err(error.as_str()),
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::time::{Duration, Instant};

    enum ResponseDelay {
        BeforeHeaders(Duration),
        BeforeBody(Duration),
    }

    pub fn spawn_response_server(
        status: u16,
        body: String,
    ) -> (String, std::thread::JoinHandle<Vec<u8>>) {
        spawn_response_server_with_content_type(status, "application/json", body)
    }

    pub fn spawn_response_server_with_content_type(
        status: u16,
        content_type: &str,
        body: String,
    ) -> (String, std::thread::JoinHandle<Vec<u8>>) {
        spawn_response_server_inner(status, content_type, body, None)
    }

    fn spawn_response_server_inner(
        status: u16,
        content_type: &str,
        body: String,
        delay: Option<ResponseDelay>,
    ) -> (String, std::thread::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let content_type = content_type.to_string();
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(30);
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(connection) => break connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if Instant::now() >= deadline {
                            return Vec::new();
                        }
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => return Vec::new(),
                }
            };
            if stream.set_nonblocking(false).is_err()
                || stream
                    .set_write_timeout(Some(Duration::from_secs(5)))
                    .is_err()
            {
                return Vec::new();
            }
            let request = match read_request(&mut stream) {
                Ok(request) => request,
                Err(_) => return Vec::new(),
            };
            let headers = format!(
                "HTTP/1.1 {} Test Response\r\nContent-Type: {}\r\nx-request-id: response-header-marker\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                status,
                content_type,
                body.len(),
            );
            match delay {
                None => {
                    if stream.write_all(headers.as_bytes()).is_err()
                        || stream.write_all(body.as_bytes()).is_err()
                    {
                        return Vec::new();
                    }
                }
                Some(ResponseDelay::BeforeHeaders(delay)) => {
                    std::thread::sleep(delay);
                    write_late_response(&mut stream, &[headers.as_bytes(), body.as_bytes()]);
                }
                Some(ResponseDelay::BeforeBody(delay)) => {
                    stream.write_all(headers.as_bytes()).unwrap();
                    stream.flush().unwrap();
                    std::thread::sleep(delay);
                    write_late_response(&mut stream, &[body.as_bytes()]);
                }
            }
            request
        });
        (format!("http://{}/response", address), server)
    }

    /// Like [`spawn_response_server`], but answers only after `delay`. A client
    /// that aborts earlier closes the stream; expected disconnect errors from
    /// the late write are accepted, while other write failures panic the fixture.
    pub fn spawn_delayed_response_server(
        delay: Duration,
        status: u16,
        body: String,
    ) -> (String, std::thread::JoinHandle<Vec<u8>>) {
        spawn_response_server_inner(
            status,
            "application/json",
            body,
            Some(ResponseDelay::BeforeHeaders(delay)),
        )
    }

    pub fn spawn_response_server_with_delayed_body(
        delay: Duration,
        status: u16,
        body: String,
    ) -> (String, std::thread::JoinHandle<Vec<u8>>) {
        spawn_response_server_inner(
            status,
            "application/json",
            body,
            Some(ResponseDelay::BeforeBody(delay)),
        )
    }

    fn write_late_response(stream: &mut TcpStream, parts: &[&[u8]]) {
        for part in parts {
            if let Err(error) = stream.write_all(part) {
                assert!(
                    matches!(
                        error.kind(),
                        std::io::ErrorKind::BrokenPipe
                            | std::io::ErrorKind::ConnectionAborted
                            | std::io::ErrorKind::ConnectionReset
                    ),
                    "unexpected delayed fixture write error: {error}"
                );
                return;
            }
        }
    }

    pub fn read_request(stream: &mut TcpStream) -> std::io::Result<Vec<u8>> {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut request = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "HTTP fixture request deadline exceeded",
                ));
            }
            stream.set_read_timeout(Some(remaining))?;
            let count = stream.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..count]);
            let Some(header_end) = request.windows(4).position(|part| part == b"\r\n\r\n") else {
                continue;
            };
            let headers = String::from_utf8_lossy(&request[..header_end]).to_ascii_lowercase();
            let body_start = header_end + 4;
            let content_length = headers
                .lines()
                .find_map(|line| line.strip_prefix("content-length: "))
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            if request.len() >= body_start + content_length {
                break;
            }
        }
        Ok(request)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;
    use std::time::{Duration, Instant};

    #[tokio::test]
    async fn no_redirect_client_does_not_forward_credentials_or_audio_on_redirect() {
        let (url, source, destination) = spawn_redirect_fixture();
        let client = shared_no_redirect().unwrap();
        let request = client
            .post(url)
            .header("x-goog-api-key", "gemini-key-marker")
            .header("Authorization", "Bearer openrouter-key-marker")
            .json(&serde_json::json!({
                "input_audio": { "data": "private-audio-marker", "format": "wav" }
            }))
            .build()
            .unwrap();

        let response = client.execute(request).await.unwrap();
        let source_request = source.join().unwrap();
        let destination_request = destination.join().unwrap();

        assert!(
            destination_request.is_none(),
            "redirect received request: {:?}",
            destination_request
        );
        assert_eq!(response.status(), reqwest::StatusCode::TEMPORARY_REDIRECT);
        let source_request = String::from_utf8_lossy(&source_request);
        assert!(source_request.contains("gemini-key-marker"));
        assert!(source_request.contains("openrouter-key-marker"));
        assert!(source_request.contains("private-audio-marker"));
        assert!(source_request.contains(USER_AGENT));
    }

    fn spawn_redirect_fixture() -> (
        String,
        std::thread::JoinHandle<Vec<u8>>,
        std::thread::JoinHandle<Option<Vec<u8>>>,
    ) {
        let destination = TcpListener::bind("127.0.0.1:0").unwrap();
        destination.set_nonblocking(true).unwrap();
        let destination_address = destination.local_addr().unwrap();
        let destination_thread = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_millis(500);
            loop {
                match destination.accept() {
                    Ok((mut stream, _)) => {
                        let request = super::test_support::read_request(&mut stream).unwrap();
                        stream
                            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                            .unwrap();
                        return Some(request);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if Instant::now() >= deadline {
                            return None;
                        }
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("redirect receiver failed: {}", error),
                }
            }
        });

        let source = TcpListener::bind("127.0.0.1:0").unwrap();
        let source_address = source.local_addr().unwrap();
        let source_thread = std::thread::spawn(move || {
            let (mut stream, _) = source.accept().unwrap();
            let request = super::test_support::read_request(&mut stream).unwrap();
            write!(
                stream,
                "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://{}/redirected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                destination_address
            )
            .unwrap();
            request
        });

        (
            format!("http://{}/provider", source_address),
            source_thread,
            destination_thread,
        )
    }
}
