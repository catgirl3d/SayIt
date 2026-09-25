// 所有 provider 共用的 HTTP 客户端。
//
// 为什么一定要带 User-Agent：**reqwest 默认一个 UA 都不发**，而 nginx / WAF 类网关
// 普遍把「无 UA」当爬虫拦掉。实测 https://test-ai-api.nwcdcloud.cn/v1（LiteLLM 网关）：
// 同一个地址 + 密钥 + 模型，带 UA 返回 200，去掉 UA 头一律 403 并回一段 nginx 的 HTML
// 错误页 —— 请求在网关就被拒了，鉴权根本没执行。我们自己的 ALB 上有同一条规则
// （见 pitfalls 第 1 条）。这类 403 的响应里一个字都不提 UA，所以只会被归成
// 「地区不可用 / 模型没开通」，用户换密钥、换模型都修不掉。
//
// 因此：provider 里**不要再写 `reqwest::Client::new()`**，一律用这里的单例。
// 附带好处是连接池和 TLS 会话得以复用，不必每次调用重建一个客户端。
pub const USER_AGENT: &str = concat!("SayIt/", env!("CARGO_PKG_VERSION"));

static SHARED: once_cell::sync::Lazy<reqwest::Client> = once_cell::sync::Lazy::new(|| {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        // 构建失败只可能是 TLS 后端初始化不了，此时退回默认客户端也不会更糟，
        // 至少不要让整个转写功能因为拿不到客户端而不可用。
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

/// 带 User-Agent 的共享客户端。超时仍按各调用点的 `.timeout()` 单独设置。
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
pub(super) mod test_support {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};

    pub fn spawn_response_server(
        status: u16,
        body: String,
    ) -> (String, std::thread::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream).unwrap();
            write!(
                stream,
                "HTTP/1.1 {} Test Response\r\nContent-Type: application/json\r\nx-request-id: response-header-marker\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                status,
                body.len(),
                body
            )
            .unwrap();
            request
        });
        (format!("http://{}/response", address), server)
    }

    pub fn read_request(stream: &mut TcpStream) -> std::io::Result<Vec<u8>> {
        stream.set_read_timeout(Some(std::time::Duration::from_secs(5)))?;
        let mut request = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
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
