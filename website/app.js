/**
 * SayIt Product Site Script
 * - RU / UK / EN localization
 * - Dark / Light theme persistence
 * - Exact SayIt Overlay wave palette, timer color, and thinking circle color math
 *   ported from client/src/lib/overlayWaveColors.ts & client/src/services/recorder/types.ts
 * - Speech -> AI Polish interactive scenario tabs
 * - SayIt-style app gallery (dynamically uses EN or UA screenshots)
 */

const TRANSLATIONS = {
  ru: {
    'nav.modes': 'Режимы',
    'nav.workflow': 'Как работает',
    'nav.features': 'Возможности',
    'nav.showcase': 'Интерфейс',
    'nav.models': 'Модели',
    'nav.selfhost': 'Сервер',
    'nav.download': 'Скачать',

    'hero.pill': 'Windows · Tauri + Rust + Vulkan · AGPL-3.0',
    'hero.title': 'Говорите естественно. Текст появляется сам.',
    'hero.subtitle':
      'Открытый голосовой ввод для Windows. Распознаёт речь локально на GPU или через ваш API, убирает слова-паразиты и вставляет чистый текст прямо туда, где стоит курсор.',
    'hero.ctaPrimary': 'Скачать для Windows',
    'hero.ctaSecondary': 'GitHub репозиторий',
    'hero.pttLabel': 'удержание',
    'hero.handsFreeLabel': 'нажать старт / стоп',

    'sim.inserted': 'Готово',
    'sim.overlayLabel': 'Оверлей:',
    'sim.stateListening': 'Запись',
    'sim.stateProcessing': 'Обработка AI',
    'sim.stateDone': 'Уведомление',
    'sim.waveLabel': 'Волна:',
    'sim.waveWhite': 'Белая',
    'sim.waveBlue': 'Синяя',
    'sim.waveRainbow': 'Радуга',
    'sim.waveCustom': 'Своя',

    'modes.eyebrow': 'Архитектура',
    'modes.title': 'Три режима работы. Полный контроль над данными.',
    'modes.desc':
      'В отличие от облачных диктовок с принудительной подпиской, SayIt явно показывает маршрут каждого аудиофрагмента.',
    'modes.local.tag': 'Готово',
    'modes.local.title': 'Локальный режим',
    'modes.local.desc':
      'Распознавание речи полностью на вашем ПК через Vulkan / GPU — без интернета.',
    'modes.local.b1': '15 GGUF-моделей с установкой в один клик',
    'modes.local.b2': 'Ноль сетевых запросов без AI-обработки',
    'modes.local.b3': 'Передача словаря терминов в AI-промпт',
    'modes.cloud.title': 'Облачный API',
    'modes.cloud.desc':
      'Прямые запросы к выбранным ASR и LLM сервисам по вашим ключам, без посредников.',
    'modes.cloud.b1': 'Потоковые титры наживо (Deepgram, Qwen, Doubao)',
    'modes.cloud.b2': 'Встроенный замер задержки (ms) на карточке',
    'modes.cloud.b3': 'OpenAI, Groq, Gemini, OpenRouter и др.',
    'modes.server.title': 'Режим сервера',
    'modes.server.desc':
      'Собственный FastAPI + WebSocket бэкенд для команды или домашнего сервера с GPU.',
    'modes.server.b1': 'Запуск через Docker Compose за пару минут',
    'modes.server.b2': 'Qwen3-ASR, FireRedASR2 и GigaAM на сервере',
    'modes.server.b3': 'Аудио не сохраняется на сервере',

    'workflow.eyebrow': 'Интеллектуальная обработка',
    'workflow.title': 'Не просто стенограмма, а готовый текст',
    'workflow.desc':
      'SayIt адаптируется под активное окно, учитывает текст вокруг курсора и выполняет голосовые команды над выделенным фрагментом.',
    'workflow.t1': 'Очистка речи',
    'workflow.t2': 'Команда над выделением',
    'workflow.t3': 'Словарь терминов',
    'workflow.rawBadge': 'Распознанная речь / Контекст',
    'workflow.outBadge': 'Результат у курсора',

    'features.eyebrow': 'Возможности',
    'features.title': 'Всё необходимое для работы с голосом',
    'features.f1.tag': 'AI + Контекст',
    'features.context.title': 'Контекстный ввод',
    'features.context.desc':
      'Считывает текст рядом с курсором (пропуская поля паролей), применяет правила под конкретные программы и редактирует выделенный текст голосом.',
    'features.subtitles.title': 'Живые субтитры и перевод',
    'features.subtitles.desc':
      'Захват системного звука через WASAPI loopback без лишних драйверов. Двойные субтитры (оригинал + перевод) для видео и звонков поверх всех окон.',
    'features.files.title': 'Транскрипция файлов',
    'features.files.desc':
      'Встроенные FFmpeg и FFprobe превращают аудио и видео в TXT и Markdown локально или через облачный профиль без внешней установки кодеков.',
    'features.audio.title': 'Чистый захват звука',
    'features.audio.desc':
      'Автоматическое или ручное усиление до 20x для тихих микрофонов, приглушение звука Windows во время записи и защита от виртуальных устройств.',
    'features.history.title': 'История и перераспознавание',
    'features.history.desc':
      'Локальный архив по дням с поиском, избранным, воспроизведением аудиозаписей и повторным распознаванием любой диктовки другой моделью.',
    'features.backup.title': 'Миграция и WebDAV',
    'features.backup.desc':
      'Экспорт настроек, словарей, AI-пресетов и архива записей для переноса на другой ПК, плюс резервное копирование по расписанию на WebDAV.',

    'showcase.eyebrow': 'Десктопный клиент',
    'showcase.title': 'Продуманный интерфейс',
    'showcase.desc':
      'Нативное приложение на Tauri с 11 темами оформления, статистикой использования и детальной настройкой каждой детали.',
    'showcase.aiToggle': 'AI-обработка',
    'showcase.groups.workspace': 'РАБОЧИЙ ПРОСТОР',
    'showcase.groups.voiceAi': 'ГОЛОС И AI',
    'showcase.groups.settings': 'НАСТРОЙКИ',
    'showcase.tabs.home': 'Главная',
    'showcase.tabs.voice': 'Голосовой движок',
    'showcase.tabs.ai': 'AI-обработка',
    'showcase.tabs.providers': 'AI-провайдеры',
    'showcase.tabs.history': 'История',
    'showcase.tabs.appearance': 'Внешний вид',
    'showcase.captions.home':
      'Статистика диктовки, активная горячая клавиша и мгновенное переключение AI-обработки в заголовке окна.',
    'showcase.captions.voice':
      'Выбор локального, облачного или серверного режима, языка речи и ASR-провайдера с замером задержки.',
    'showcase.captions.ai':
      'Гибкие пресеты, словарь терминов, контекстное редактирование выделенного текста и правила для приложений.',
    'showcase.captions.providers':
      'Собственные API-ключи, OpenAI-совместимые эндпоинты и проверка скорости отклика каждой модели.',
    'showcase.captions.history':
      'Локальный архив по дням с поиском, избранным, прослушиванием аудио и повторным распознаванием.',
    'showcase.captions.appearance':
      '11 светлых и тёмных тем, настройка анимаций и интерактивный конструктор волны оверлея.',

    'models.eyebrow': 'Экосистема',
    'models.title': 'Любые модели ASR и LLM',
    'models.localTitle': '15 локальных моделей',
    'models.localDesc': 'Загружаются и удаляются прямо в SayIt:',
    'models.cloudAsrTitle': 'Облачное распознавание',
    'models.cloudAsrDesc': 'Потоковые и пакетные провайдеры:',
    'models.aiTitle': 'Провайдеры AI-обработки',
    'models.aiDesc': 'Для редактуры, перевода и команд:',

    'selfhost.eyebrow': 'Self-Hosting',
    'selfhost.title': 'Свой сервер за пару минут',
    'selfhost.desc':
      'Бэкенд объединяет FastAPI, потоковый WebSocket, выбор ASR-движка (Qwen3-ASR, FireRedASR2 или GigaAM) и опциональную AI-обработку через OpenAI, Azure OpenAI, Groq или Ollama.',
    'selfhost.s1': 'Установите клиент SayIt для Windows (или соберите из исходников)',
    'selfhost.s2': 'Поднимите контейнер Docker Compose на Linux-машине с GPU',
    'selfhost.s3': 'Укажите адрес сервера в настройках «Голосового движка»',
    'selfhost.copy': 'Копировать',
    'selfhost.copied': 'Скопировано',

    'cta.title': 'Попробуйте SayIt на Windows',
    'cta.desc':
      'Полностью открытый код под лицензией AGPL-3.0. Без подписок и привязки к одному провайдеру.',
    'cta.download': 'Скачать последний релиз',
    'cta.changelog': 'Список изменений',
    'footer.fork': 'Независимый форк на базе crosswk/SayIt',
    'footer.releases': 'Релизы',
  },

  uk: {
    'nav.modes': 'Режими',
    'nav.workflow': 'Як працює',
    'nav.features': 'Можливості',
    'nav.showcase': 'Інтерфейс',
    'nav.models': 'Моделі',
    'nav.selfhost': 'Сервер',
    'nav.download': 'Завантажити',

    'hero.pill': 'Windows · Tauri + Rust + Vulkan · AGPL-3.0',
    'hero.title': 'Говоріть природно. Текст з’являється сам.',
    'hero.subtitle':
      'Відкрите голосове введення для Windows. Розпізнає мовлення локально на GPU або через ваш API, прибирає слова-паразити й вставляє чистий текст просто у курсор.',
    'hero.ctaPrimary': 'Завантажити для Windows',
    'hero.ctaSecondary': 'GitHub репозиторій',
    'hero.pttLabel': 'утримання',
    'hero.handsFreeLabel': 'натиснути старт / стоп',

    'sim.inserted': 'Готово',
    'sim.overlayLabel': 'Оверлей:',
    'sim.stateListening': 'Запис',
    'sim.stateProcessing': 'Обробка AI',
    'sim.stateDone': 'Повідомлення',
    'sim.waveLabel': 'Хвиля:',
    'sim.waveWhite': 'Біла',
    'sim.waveBlue': 'Синя',
    'sim.waveRainbow': 'Веселка',
    'sim.waveCustom': 'Власна',

    'modes.eyebrow': 'Архітектура',
    'modes.title': 'Три режими роботи. Повний контроль над даними.',
    'modes.desc':
      'На відміну від хмарних диктувань із примусовою підпискою, SayIt явно показує маршрут кожного аудіофрагмента.',
    'modes.local.tag': 'Готово',
    'modes.local.title': 'Локальний режим',
    'modes.local.desc':
      'Розпізнавання мовлення повністю на вашому ПК через Vulkan / GPU — без інтернету.',
    'modes.local.b1': '15 GGUF-моделей зі встановленням в один клік',
    'modes.local.b2': 'Нуль мережевих запитів без AI-обробки',
    'modes.local.b3': 'Передача словника термінів в AI-промпт',
    'modes.cloud.title': 'Хмарний API',
    'modes.cloud.desc':
      'Прямі запити до обраних ASR та LLM сервісів за вашими ключами, без посередників.',
    'modes.cloud.b1': 'Потокові субтитри наживо (Deepgram, Qwen, Doubao)',
    'modes.cloud.b2': 'Вбудований вимір затримки (ms) на картці',
    'modes.cloud.b3': 'OpenAI, Groq, Gemini, OpenRouter тощо',
    'modes.server.title': 'Режим сервера',
    'modes.server.desc':
      'Власний FastAPI + WebSocket бекенд для команди або домашнього сервера з GPU.',
    'modes.server.b1': 'Запуск через Docker Compose за кілька хвилин',
    'modes.server.b2': 'Qwen3-ASR, FireRedASR2 і GigaAM на сервері',
    'modes.server.b3': 'Аудіо не зберігається на сервері',

    'workflow.eyebrow': 'Інтелектуальна обробка',
    'workflow.title': 'Не просто стенограма, а готовий текст',
    'workflow.desc':
      'SayIt адаптується під активне вікно, враховує текст навколо курсора і виконує голосові команди над виділеним фрагментом.',
    'workflow.t1': 'Очищення мовлення',
    'workflow.t2': 'Команда над виділенням',
    'workflow.t3': 'Словник термінів',
    'workflow.rawBadge': 'Розпізнане мовлення / Контекст',
    'workflow.outBadge': 'Результат у курсора',

    'features.eyebrow': 'Можливості',
    'features.title': 'Усе необхідне для роботи з голосом',
    'features.f1.tag': 'AI + Контекст',
    'features.context.title': 'Контекстне введення',
    'features.context.desc':
      'Зчитує текст поруч із курсором (пропускаючи поля паролів), застосовує правила для окремих програм і редагує виділений текст голосом.',
    'features.subtitles.title': 'Живі субтитри та переклад',
    'features.subtitles.desc':
      'Захоплення системного звуку через WASAPI loopback без зайвих драйверів. Подвійні субтитри (оригінал + переклад) для відео та дзвінків поверх усіх вікон.',
    'features.files.title': 'Транскрипція файлів',
    'features.files.desc':
      'Вбудовані FFmpeg і FFprobe перетворюють аудіо та відео на TXT і Markdown локально або через хмарний профіль без зовнішнього встановлення кодеків.',
    'features.audio.title': 'Чистий запис звуку',
    'features.audio.desc':
      'Автоматичне або ручне підсилення до 20x для тихих мікрофонів, приглушення звуку Windows під час запису й захист від віртуальних пристроїв.',
    'features.history.title': 'Історія та перерозпізнавання',
    'features.history.desc':
      'Локальний архів за днями з пошуком, обраними, відтворенням аудіозаписів і повторним розпізнаванням будь-якого диктування іншою моделлю.',
    'features.backup.title': 'Міграція та WebDAV',
    'features.backup.desc':
      'Експорт налаштувань, словників, AI-пресетів та архіву записів для перенесення на інший ПК, плюс резервне копіювання за розкладом на WebDAV.',

    'showcase.eyebrow': 'Десктопний клієнт',
    'showcase.title': 'Продуманий інтерфейс',
    'showcase.desc':
      'Нативний застосунок на Tauri з 11 темами оформлення, статистикою використання та детальним налаштуванням кожної деталі.',
    'showcase.aiToggle': 'AI-обробка',
    'showcase.groups.workspace': 'РОБОЧИЙ ПРОСТІР',
    'showcase.groups.voiceAi': 'ГОЛОС І AI',
    'showcase.groups.settings': 'НАЛАШТУВАННЯ',
    'showcase.tabs.home': 'Головна',
    'showcase.tabs.voice': 'Голосовий рушій',
    'showcase.tabs.ai': 'AI-обробка',
    'showcase.tabs.providers': 'Провайдери AI',
    'showcase.tabs.history': 'Історія',
    'showcase.tabs.appearance': 'Зовнішній вигляд',
    'showcase.captions.home':
      'Статистика диктування, активна гаряча клавіша та миттєве перемикання AI-обробки в заголовку вікна.',
    'showcase.captions.voice':
      'Вибір локального, хмарного або серверного режиму, мови розпізнавання та ASR-провайдера з виміром затримки.',
    'showcase.captions.ai':
      'Гнучкі пресети, словник термінів, контекстне редагування виділеного тексту та правила для застосунків.',
    'showcase.captions.providers':
      'Власні API-ключі, OpenAI-сумісні ендпоїнти та перевірка швидкості відгуку кожної моделі.',
    'showcase.captions.history':
      'Локальний архів за днями з пошуком, обраними, прослуховуванням аудіо та повторним розпізнаванням.',
    'showcase.captions.appearance':
      '11 світлих і темних тем, налаштування анімацій та інтерактивний конструктор хвилі оверлея.',

    'models.eyebrow': 'Екосистема',
    'models.title': 'Будь-які моделі ASR та LLM',
    'models.localTitle': '15 локальних моделей',
    'models.localDesc': 'Завантажуються і видаляються просто в SayIt:',
    'models.cloudAsrTitle': 'Хмарне розпізнавання',
    'models.cloudAsrDesc': 'Потокові та пакетні провайдери:',
    'models.aiTitle': 'Провайдери AI-обробки',
    'models.aiDesc': 'Для редактури, перекладу та команд:',

    'selfhost.eyebrow': 'Self-Hosting',
    'selfhost.title': 'Власний сервер за кілька хвилин',
    'selfhost.desc':
      'Бекенд поєднує FastAPI, потоковий WebSocket, вибір ASR-рушія (Qwen3-ASR, FireRedASR2 або GigaAM) та опціональну AI-обробку через OpenAI, Azure OpenAI, Groq або Ollama.',
    'selfhost.s1': 'Встановіть клієнт SayIt для Windows (або зберіть із вихідного коду)',
    'selfhost.s2': 'Підніміть контейнер Docker Compose на Linux-машині з GPU',
    'selfhost.s3': 'Вкажіть адресу сервера в налаштуваннях «Голосового рушія»',
    'selfhost.copy': 'Копіювати',
    'selfhost.copied': 'Скопійовано',

    'cta.title': 'Спробуйте SayIt на Windows',
    'cta.desc':
      'Повністю відкритий код за ліцензією AGPL-3.0. Без підписок і прив’язки до одного провайдера.',
    'cta.download': 'Завантажити останній реліз',
    'cta.changelog': 'Список змін',
    'footer.fork': 'Незалежний форк на базі crosswk/SayIt',
    'footer.releases': 'Релізи',
  },

  en: {
    'nav.modes': 'Modes',
    'nav.workflow': 'Workflow',
    'nav.features': 'Features',
    'nav.showcase': 'Interface',
    'nav.models': 'Models',
    'nav.selfhost': 'Self-Host',
    'nav.download': 'Download',

    'hero.pill': 'Windows · Tauri + Rust + Vulkan · AGPL-3.0',
    'hero.title': 'Speak naturally. Polished text appears.',
    'hero.subtitle':
      'Open-source voice typing for Windows. Runs locally on your GPU or through your own API keys, cleans up filler words with AI, and inserts text right at your cursor.',
    'hero.ctaPrimary': 'Download for Windows',
    'hero.ctaSecondary': 'GitHub Repository',
    'hero.pttLabel': 'hold to talk',
    'hero.handsFreeLabel': 'press start / stop',

    'sim.inserted': 'Inserted',
    'sim.overlayLabel': 'Overlay:',
    'sim.stateListening': 'Listening',
    'sim.stateProcessing': 'Processing',
    'sim.stateDone': 'Notice',
    'sim.waveLabel': 'Waveform:',
    'sim.waveWhite': 'White on black',
    'sim.waveBlue': 'Blue on black',
    'sim.waveRainbow': 'Rainbow on black',
    'sim.waveCustom': 'Custom',

    'modes.eyebrow': 'Architecture',
    'modes.title': 'Three ways to run. Complete data transparency.',
    'modes.desc':
      'Unlike locked-in subscription dictation apps, SayIt shows exactly where every audio frame and text snippet goes.',
    'modes.local.tag': 'Ready',
    'modes.local.title': 'Local Mode',
    'modes.local.desc':
      'Speech recognition runs 100% on your PC with Vulkan / GPU acceleration—no internet needed.',
    'modes.local.b1': '15 GGUF models managed inside the app',
    'modes.local.b2': 'Zero network traffic with AI processing off',
    'modes.local.b3': 'Hotword dictionary injected into AI prompt',
    'modes.cloud.title': 'Cloud API Mode',
    'modes.cloud.desc':
      'Talk directly to your chosen ASR and LLM providers with your own keys and zero middlemen.',
    'modes.cloud.b1': 'Live streaming captions (Deepgram, Qwen, Doubao)',
    'modes.cloud.b2': 'Built-in round-trip latency (ms) on every card',
    'modes.cloud.b3': 'OpenAI, Groq, Gemini, OpenRouter & more',
    'modes.server.title': 'Server Mode',
    'modes.server.desc':
      'Connect to your own FastAPI & WebSocket backend for teams or a dedicated GPU box.',
    'modes.server.b1': 'Deploy with Docker Compose in minutes',
    'modes.server.b2': 'Run Qwen3-ASR, FireRedASR2, or GigaAM',
    'modes.server.b3': 'Audio is never retained on the server',

    'workflow.eyebrow': 'Intelligent Pipeline',
    'workflow.title': 'Not just raw transcripts—ready-to-send writing',
    'workflow.desc':
      'SayIt adapts to your active app, reads surrounding editor context when enabled, and executes spoken commands on selected text.',
    'workflow.t1': 'Speech Cleanup',
    'workflow.t2': 'Selection Command',
    'workflow.t3': 'Hotwords Dictionary',
    'workflow.rawBadge': 'Raw Speech / Context',
    'workflow.outBadge': 'Inserted at Cursor',

    'features.eyebrow': 'Capabilities',
    'features.title': 'Everything you need for voice-first work',
    'features.f1.tag': 'AI + Context',
    'features.context.title': 'Context-aware writing',
    'features.context.desc':
      'Reads text around the cursor (skipping password fields), applies per-application rules, and edits selected text with spoken instructions.',
    'features.subtitles.title': 'Live subtitles & translation',
    'features.subtitles.desc':
      'Native Windows WASAPI loopback audio capture with zero virtual drivers. Dual subtitles (original + translation) in a click-through overlay.',
    'features.files.title': 'Audio & video transcription',
    'features.files.desc':
      'Bundled FFmpeg and FFprobe turn meetings and media into TXT and Markdown transcripts locally or via your cloud profile.',
    'features.audio.title': 'Clean audio capture',
    'features.audio.desc':
      'Manual or auto mic boost up to 20x, optional system audio mute while recording, and automatic fallback from silent virtual mics.',
    'features.history.title': 'History & re-transcribe',
    'features.history.desc':
      'Searchable day-grouped local archive with starred items, audio playback, and one-click re-transcription using another model.',
    'features.backup.title': 'Migration & WebDAV',
    'features.backup.desc':
      'Export settings, hotwords, AI presets, or full recording archives across PCs, plus scheduled automatic backups to your WebDAV server.',

    'showcase.eyebrow': 'Desktop Client',
    'showcase.title': 'Refined native interface',
    'showcase.desc':
      'Fast Tauri desktop app featuring 11 light and dark themes, usage stats, and granular controls for every stage.',
    'showcase.aiToggle': 'AI processing',
    'showcase.groups.workspace': 'WORKSPACE',
    'showcase.groups.voiceAi': 'VOICE & AI',
    'showcase.groups.settings': 'SETTINGS',
    'showcase.tabs.home': 'Home',
    'showcase.tabs.voice': 'Voice engine',
    'showcase.tabs.ai': 'AI processing',
    'showcase.tabs.providers': 'AI providers',
    'showcase.tabs.history': 'History',
    'showcase.tabs.appearance': 'Appearance',
    'showcase.captions.home':
      'Dictation stats, active hotkey indicator, and instant AI toggle right in the title bar.',
    'showcase.captions.voice':
      'Switch between Local, Cloud API, or Server mode, choose speech language, and benchmark ASR latency.',
    'showcase.captions.ai':
      'Editable presets, hotword injection, context awareness, and per-application prompt rules.',
    'showcase.captions.providers':
      'Use your own API keys, connect any OpenAI-compatible endpoint, and measure response latency.',
    'showcase.captions.history':
      'Day-grouped local archive with search, raw transcript view, audio playback, and re-transcribe.',
    'showcase.captions.appearance':
      '11 light and dark themes, motion controls, and custom OKLCH overlay waveform builder.',

    'models.eyebrow': 'Ecosystem',
    'models.title': 'Freedom to pick any ASR & LLM',
    'models.localTitle': '15 Local Models',
    'models.localDesc': 'Download and remove inside SayIt:',
    'models.cloudAsrTitle': 'Cloud Speech Recognition',
    'models.cloudAsrDesc': 'Streaming and buffered providers:',
    'models.aiTitle': 'AI Processing Providers',
    'models.aiDesc': 'For cleanup, translation, and commands:',

    'selfhost.eyebrow': 'Self-Hosting',
    'selfhost.title': 'Your own server in minutes',
    'selfhost.desc':
      'Combines FastAPI, WebSocket streaming, selectable ASR engines (Qwen3-ASR, FireRedASR2, or GigaAM), and optional AI cleanup via OpenAI, Azure OpenAI, Groq, or Ollama.',
    'selfhost.s1': 'Install the Windows desktop client (or build from source)',
    'selfhost.s2': 'Launch Docker Compose on a Linux host with a GPU',
    'selfhost.s3': 'Enter your server URL in Voice Engine settings',
    'selfhost.copy': 'Copy',
    'selfhost.copied': 'Copied',

    'cta.title': 'Try SayIt on Windows',
    'cta.desc':
      '100% open-source under AGPL-3.0. No subscriptions and no single-cloud lock-in.',
    'cta.download': 'Download Latest Release',
    'cta.changelog': 'View Changelog',
    'footer.fork': 'Independent fork based on crosswk/SayIt',
    'footer.releases': 'Releases',
  },
};

const WORKFLOW_SCENARIOS = {
  ru: {
    polish: {
      inMeta: 'Сырая речь · Whisper Large v3 Turbo',
      inText:
        '«Э-э, короче, давай перенесём созвон по релизу на завтра на десять утра, и, ну, не забудь прикрепить заметки по тестированию»',
      outMeta: '280ms',
      outText:
        'Давайте перенесём созвон по релизу на завтра на 10:00. Пожалуйста, не забудьте прикрепить заметки по тестированию.',
    },
    selection: {
      inMeta: 'Выделенный текст + голосовая команда: «Сократи и переведи на английский»',
      inText:
        'Выделено: «Мы обновили модуль резервного копирования WebDAV, чтобы он поддерживал расписание и не перезаписывал локальный идентификатор устройства.»',
      outMeta: '310ms',
      outText:
        'Updated WebDAV backups with scheduling while keeping local device IDs intact.',
    },
    hotwords: {
      inMeta: 'Словарь терминов: Tauri, WASAPI, WebDAV, GigaAM',
      inText:
        '«В новом релизе мы перевели васапи петлю на гига ам и добавили бэкап на вебдав в таури»',
      outMeta: '240ms',
      outText:
        'В новом релизе мы перевели WASAPI loopback на GigaAM и добавили резервное копирование WebDAV в Tauri.',
    },
  },
  uk: {
    polish: {
      inMeta: 'Сире мовлення · Whisper Large v3 Turbo',
      inText:
        '«Е-е, коротше, давай перенесемо дзвінок щодо релізу на завтра на десяту ранку, і, ну, не забудь додати нотатки з тестування»',
      outMeta: '280ms',
      outText:
        'Перенесімо дзвінок щодо релізу на завтра на 10:00. Будь ласка, не забудьте додати нотатки з тестування.',
    },
    selection: {
      inMeta: 'Виділений текст + голосова команда: «Скороти і переклади англійською»',
      inText:
        'Виділено: «Ми оновили модуль резервного копіювання WebDAV, щоб він підтримував розклад і не перезаписував локальний ідентифікатор пристрою.»',
      outMeta: '310ms',
      outText:
        'Updated WebDAV backups with scheduling while keeping local device IDs intact.',
    },
    hotwords: {
      inMeta: 'Словник термінів: Tauri, WASAPI, WebDAV, GigaAM',
      inText:
        '«У новому релізі ми перевели васапі петлю на гіга ам і додали бекап на вебдав у таурі»',
      outMeta: '240ms',
      outText:
        'У новому релізі ми перевели WASAPI loopback на GigaAM і додали резервне копіювання WebDAV у Tauri.',
    },
  },
  en: {
    polish: {
      inMeta: 'Raw speech · Whisper Large v3 Turbo',
      inText:
        '"So, um, let’s move the release sync to tomorrow at ten a.m., and, uh, don’t forget to attach the QA notes"',
      outMeta: '280ms',
      outText:
        'Let’s move the release sync to tomorrow at 10:00 AM, and please don’t forget to attach the QA notes.',
    },
    selection: {
      inMeta: 'Selected text + spoken command: "Tighten this into one crisp sentence"',
      inText:
        'Selected: "We made an update to the WebDAV backup module so that it supports schedules and avoids overwriting your local device ID."',
      outMeta: '310ms',
      outText:
        'Scheduled WebDAV backups now preserve your local device ID.',
    },
    hotwords: {
      inMeta: 'Hotwords: Tauri, WASAPI, WebDAV, GigaAM',
      inText:
        '"In the new release we moved wasabi loopback to giga am and added web dav backups in towery"',
      outMeta: '240ms',
      outText:
        'In the new release, we moved WASAPI loopback to GigaAM and added WebDAV backups in Tauri.',
    },
  },
};

const SCREEN_ASSETS = {
  home: { en: './assets/home-en.png', uk: './assets/home-ua.png' },
  voice: { en: './assets/voice-engine-en.png', uk: './assets/voice-engine-ua.png' },
  ai: { en: './assets/ai-processing-en.png', uk: './assets/ai-processing-ua.png' },
  providers: { en: './assets/ai-providers-en.png', uk: './assets/ai-providers-ua.png' },
  history: { en: './assets/history-en.png', uk: './assets/history-ua.png' },
  appearance: { en: './assets/appearance-en.png', uk: './assets/appearance-ua.png' },
};

const DEFAULT_BAR_COUNT = 18;
const BAR_MIN_HEIGHT = 3;
const BAR_MAX_HEIGHT = 18;
const BAR_ATTACK = 0.45;
const BAR_DECAY = 0.12;
const BAR_CENTER_SHAPE = 0.15;
const waveHeights = new Array(DEFAULT_BAR_COUNT).fill(BAR_MIN_HEIGHT);
let speechEnergy = 0.75;
let lastWaveFrame = 0;

/**
 * Exact wave palette math from client/src/lib/overlayWaveColors.ts
 */
function buildWavePalette(total, theme) {
  const denom = Math.max(1, total - 1);
  return Array.from({ length: total }, (_, index) => {
    const t = index / denom;
    switch (theme) {
      case 'black-white':
        return '#f1f5f9';
      case 'black-blue': {
        const hue = 190 + Math.round(t * 30);
        const lightness = 62 - Math.round(Math.abs(t - 0.5) * 14);
        return `hsl(${hue} 90% ${lightness}%)`;
      }
      case 'black-rainbow': {
        const hue = 140 - Math.round(t * 110);
        const lightness = 64 - Math.round(Math.abs(t - 0.5) * 12);
        return `hsl(${hue} 95% ${lightness}%)`;
      }
      case 'custom': {
        // Interpolates DEFAULT_CUSTOM_WAVE (#a78bfa -> #f472b6) through vibrant magenta
        const r = Math.round(167 + (244 - 167) * t);
        const g = Math.round(139 + (114 - 139) * t);
        const b = Math.round(250 + (182 - 250) * t);
        return `rgb(${r}, ${g}, ${b})`;
      }
      default:
        return '#f1f5f9';
    }
  });
}

function getWaveTimerColor(theme) {
  switch (theme) {
    case 'black-white':
      return '#e5e7eb';
    case 'black-blue':
      return '#bae6fd';
    case 'black-rainbow':
      return '#fef08a';
    case 'custom':
      return '#f5d0fe';
    default:
      return '#fef08a';
  }
}

function getWaveThinkingColor(theme) {
  switch (theme) {
    case 'black-white':
      return '#e2e8f0';
    case 'black-blue':
      return '#38bdf8';
    case 'black-rainbow':
      return '#facc15';
    case 'custom':
      return '#e879f9';
    default:
      return '#facc15';
  }
}

const state = {
  lang: 'ru',
  simState: 'listening',
  waveTheme: 'black-rainbow',
  screen: 'home',
  scenario: 'polish',
  timerSec: 4,
};

function updateLanguage(lang) {
  state.lang = TRANSLATIONS[lang] ? lang : 'ru';
  document.documentElement.lang = state.lang;
  localStorage.setItem('sayit-site-lang', state.lang);

  const dict = TRANSLATIONS[state.lang];
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (dict[key]) {
      el.textContent = dict[key];
    }
  });

  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.lang === state.lang);
  });

  const heroImg = document.getElementById('heroStageImg');
  if (heroImg) {
    heroImg.src = state.lang === 'uk' ? SCREEN_ASSETS.home.uk : SCREEN_ASSETS.home.en;
  }

  renderWorkflowScenario();
  renderShowcase();
}

function setTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('sayit-site-theme', next);
  const favicon = document.getElementById('siteFavicon');
  if (favicon) {
    favicon.setAttribute('href', next === 'light' ? './assets/icon-on-light.png' : './assets/icon-on-dark.png');
  }
}

function renderOverlayPill() {
  const pill = document.getElementById('overlayPill');
  const listening = document.getElementById('pillListening');
  const processing = document.getElementById('pillProcessing');
  const notice = document.getElementById('pillNotice');
  if (!pill || !listening || !processing || !notice) return;

  pill.dataset.state = state.simState;
  listening.hidden = state.simState !== 'listening';
  processing.hidden = state.simState !== 'processing';
  notice.hidden = state.simState !== 'done';

  document.querySelectorAll('[data-sim-state]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.simState === state.simState);
  });
}

function renderWorkflowScenario() {
  const scenarios = WORKFLOW_SCENARIOS[state.lang] || WORKFLOW_SCENARIOS.en;
  const item = scenarios[state.scenario] || scenarios.polish;

  const inMeta = document.getElementById('wfInputMeta');
  const inText = document.getElementById('wfInputText');
  const outMeta = document.getElementById('wfOutputMeta');
  const outText = document.getElementById('wfOutputText');

  if (inMeta) inMeta.textContent = item.inMeta;
  if (inText) inText.textContent = item.inText;
  if (outMeta) outMeta.textContent = item.outMeta;
  if (outText) outText.textContent = item.outText;

  document.querySelectorAll('[data-scenario]').forEach((btn) => {
    const active = btn.dataset.scenario === state.scenario;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
}

function initWaveBars() {
  const container = document.getElementById('waveBars');
  if (!container) return;

  container.innerHTML = '';
  for (let i = 0; i < DEFAULT_BAR_COUNT; i += 1) {
    const bar = document.createElement('span');
    bar.className = 'sayit-wave-bar';
    container.appendChild(bar);
  }
  applyWaveTheme();
}

function applyWaveTheme() {
  const bars = document.querySelectorAll('#waveBars .sayit-wave-bar');
  const palette = buildWavePalette(bars.length, state.waveTheme);
  bars.forEach((bar, idx) => {
    bar.style.backgroundColor = palette[idx];
  });

  const timerEl = document.getElementById('pillTimer');
  if (timerEl) {
    timerEl.style.color = getWaveTimerColor(state.waveTheme);
  }

  const thinkingColor = getWaveThinkingColor(state.waveTheme);
  const ring = document.getElementById('thinkingRingCircle');
  const sparkle = document.getElementById('thinkingSparkle');
  if (ring) ring.setAttribute('stroke', thinkingColor);
  if (sparkle) sparkle.style.color = thinkingColor;

  document.querySelectorAll('[data-wave-theme]').forEach((btn) => {
    const active = btn.dataset.waveTheme === state.waveTheme;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', String(active));
  });
}

function animateWave(now) {
  const FRAME_INTERVAL = 1000 / 30;
  if (now - lastWaveFrame >= FRAME_INTERVAL) {
    lastWaveFrame = now;
    const bars = document.querySelectorAll('#waveBars .sayit-wave-bar');
    const center = (DEFAULT_BAR_COUNT - 1) / 2;

    // Simulate natural speech cadence with brief pauses between spoken phrases
    const phraseWave = Math.sin(now / 620) * 0.35 + Math.sin(now / 290) * 0.25 + 0.65;
    speechEnergy = Math.max(0.18, Math.min(1, phraseWave));

    bars.forEach((bar, idx) => {
      const centerDist = Math.abs(idx - center) / Math.max(1, center);
      const shape = Math.max(0.7, 1 - centerDist * BAR_CENTER_SHAPE);
      const target = Math.max(
        BAR_MIN_HEIGHT,
        (BAR_MIN_HEIGHT + Math.random() * (BAR_MAX_HEIGHT - BAR_MIN_HEIGHT) * speechEnergy) * shape,
      );
      const prev = waveHeights[idx];
      waveHeights[idx] = target > prev
        ? prev + (target - prev) * BAR_ATTACK
        : prev + (target - prev) * BAR_DECAY;

      const h = Math.min(BAR_MAX_HEIGHT, Math.max(BAR_MIN_HEIGHT, waveHeights[idx]));
      bar.style.height = `${h.toFixed(1)}px`;
      bar.style.opacity = String(0.7 + (h / BAR_MAX_HEIGHT) * 0.3);
    });
  }
  requestAnimationFrame(animateWave);
}

function renderShowcase() {
  const img = document.getElementById('showcaseImage');
  const caption = document.getElementById('showcaseCaption');
  if (!img || !caption) return;

  const variant = state.lang === 'uk' ? 'uk' : 'en';
  const entry = SCREEN_ASSETS[state.screen] || SCREEN_ASSETS.home;
  img.src = entry[variant];

  const dict = TRANSLATIONS[state.lang];
  caption.textContent = dict[`showcase.captions.${state.screen}`] || '';

  document.querySelectorAll('[data-screen]').forEach((btn) => {
    const active = btn.dataset.screen === state.screen;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const savedTheme = localStorage.getItem('sayit-site-theme') || 'dark';
  setTheme(savedTheme);

  const savedLang = localStorage.getItem('sayit-site-lang');
  const browserLang = (navigator.language || '').toLowerCase();
  const initialLang =
    savedLang ||
    (browserLang.startsWith('uk') ? 'uk' : browserLang.startsWith('ru') ? 'ru' : 'en');

  initWaveBars();
  updateLanguage(initialLang);
  renderOverlayPill();

  requestAnimationFrame(animateWave);

  setInterval(() => {
    if (state.simState !== 'listening') return;
    state.timerSec = state.timerSec >= 59 ? 1 : state.timerSec + 1;
    const timerEl = document.getElementById('pillTimer');
    if (timerEl) {
      timerEl.textContent = `${state.timerSec}s`;
    }
  }, 1000);

  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.addEventListener('click', () => updateLanguage(btn.dataset.lang));
  });

  document.getElementById('themeToggle')?.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    setTheme(current === 'light' ? 'dark' : 'light');
  });

  document.querySelectorAll('[data-sim-state]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.simState = btn.dataset.simState;
      renderOverlayPill();
    });
  });

  document.querySelectorAll('[data-wave-theme]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.waveTheme = btn.dataset.waveTheme;
      applyWaveTheme();
    });
  });

  document.querySelectorAll('[data-scenario]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.scenario = btn.dataset.scenario;
      renderWorkflowScenario();
    });
  });

  document.querySelectorAll('[data-screen]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.screen = btn.dataset.screen;
      renderShowcase();
    });
  });

  document.getElementById('copyDockerBtn')?.addEventListener('click', async () => {
    const code = document.getElementById('dockerCode')?.textContent || '';
    const label = document.querySelector('#copyDockerBtn span');
    if (!code || !label) return;
    try {
      await navigator.clipboard.writeText(code);
      label.textContent = TRANSLATIONS[state.lang]['selfhost.copied'];
      setTimeout(() => {
        label.textContent = TRANSLATIONS[state.lang]['selfhost.copy'];
      }, 1800);
    } catch {
      // Clipboard API may be unavailable on non-HTTPS local file previews
    }
  });

  const menuBtn = document.getElementById('mobileMenuBtn');
  const mobileNav = document.getElementById('mobileNav');
  menuBtn?.addEventListener('click', () => {
    if (!mobileNav) return;
    const isHidden = mobileNav.hasAttribute('hidden');
    if (isHidden) {
      mobileNav.removeAttribute('hidden');
      menuBtn.setAttribute('aria-expanded', 'true');
    } else {
      mobileNav.setAttribute('hidden', '');
      menuBtn.setAttribute('aria-expanded', 'false');
    }
  });

  mobileNav?.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => {
      mobileNav.setAttribute('hidden', '');
      menuBtn?.setAttribute('aria-expanded', 'false');
    });
  });
});
