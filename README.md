# Light Monitor Bot 💡

Telegram бот для мониторинга состояния электричества через роутер или другие устройства.

## Быстрый старт

1. **Установите зависимости:**
   ```bash
   npm install
   ```

2. **Настройте переменные окружения** (`.env` файл):
   ```env
   TELEGRAM_TOKEN=your_telegram_bot_token
   WEBHOOK_URL=https://your-app.onrender.com
   GOOGLE_SHEET_ID=your_google_sheet_id
   GOOGLE_CREDENTIALS={"type":"service_account",...}
   ```

3. **Запустите локально:**
   ```bash
   npm start
   ```

## Деплой

Подробная инструкция: [DEPLOY.md](./DEPLOY.md)

Кратко:
- Настройте Google Sheets API ([инструкция](./GOOGLE_SHEETS_SETUP.md))
- Деплойте на Render.com через GitHub
- Настройте cron для проверок (UptimeRobot/cron-job.org)

## API Endpoints

- `GET/POST /ping?chat_id=YOUR_CHAT_ID` - пинг от устройства
- `GET /check-lights` - проверка состояния (для cron)
- `POST /bot<TOKEN>` - Telegram webhook

## Telegram команды

- `/start` - информация о боте
- `/status` - текущее состояние света
- `/address` - настройка адреса
- `/dtek` - информация об отключениях

## Устройства для мониторинга

Любое устройство с интернетом, может использоваться для мониторинга:

### OpenWrt роутеры
```bash
# Пример для OpenWrt с curl
curl "https://your-app.onrender.com/ping?chat_id=YOUR_CHAT_ID"
```

### Raspberry Pi / Linux
```bash
# Cron job каждые 30 секунд
*/2 * * * * curl -s "https://your-app.onrender.com/ping?chat_id=YOUR_CHAT_ID" > /dev/null
```

### ESP8266/ESP32
```cpp
const char* serverUrl = "https://your-app.onrender.com/ping?chat_id=YOUR_CHAT_ID";

void loop() {
  HTTPClient http;
  http.begin(serverUrl);
  http.GET();
  http.end();
  delay(60000);
}
```

### Android устройства
```bash
# Установите Termux: https://termux.dev/
# В Termux установите curl:
pkg install curl

# Создайте скрипт ping.sh:
echo '#!/bin/bash
curl -s "https://your-app.onrender.com/ping?chat_id=YOUR_CHAT_ID" > /dev/null' > ping.sh
chmod +x ping.sh

# Запуск каждые 30 секунд с помощью termux-job-scheduler:
pkg install termux-job-scheduler
termux-job-scheduler -s ./ping.sh -p 30
```

Или используйте **Tasker** приложение:
- Создайте задачу "HTTP GET"
- URL: `https://your-app.onrender.com/ping?chat_id=YOUR_CHAT_ID`
- Повторять каждые 30 секунд

### Любое устройство с интернетом
- Роутеры с OpenWrt/DD-WRT
- Raspberry Pi / Orange Pi
- Android устройства (Termux/Tasker)
- Arduino с Ethernet shield
- Компьютеры с cron/bash скриптами
- IoT устройства с HTTP клиентом

**Главное требование**: устройство должно иметь доступ к интернету и возможность отправлять HTTP GET/POST запросы.
