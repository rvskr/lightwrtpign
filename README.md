# Light Monitor Bot 💡

Telegram бот для мониторинга состояния электричества через ESP8266/ESP32.

## Что делает приложение

Приложение отслеживает состояние света и отправляет уведомления в Telegram:
- 🔌 Получает пинги от устройства (ESP8266/ESP32) каждые 30 секунд
- 💡 Определяет когда свет включен/выключен
- 📱 Отправляет уведомления в Telegram при изменении состояния
- ⏱️ Показывает длительность включения/выключения
- 📊 Команда `/status` для проверки текущего состояния

## Технологии

- **Backend**: Node.js + Express
- **База данных**: PostgreSQL (Sequelize ORM)
- **Telegram**: node-telegram-bot-api (webhooks)
- **Хостинг**: Render.com (бесплатно)

## Быстрый старт

### 1. Установка зависимостей

```bash
npm install
```

### 2. Настройка переменных окружения

Создайте файл `.env`:

```env
TELEGRAM_TOKEN=your_telegram_bot_token
WEBHOOK_URL=https://your-app.onrender.com
DATABASE_URL=postgresql://user:password@host:5432/database
PORT=5002
```

### 3. Локальный запуск

```bash
npm start
```

## Деплой на Render.com

Полная инструкция в файле [DEPLOY.md](./DEPLOY.md)

### Краткая версия:

1. **Создайте PostgreSQL базу** на Render (бесплатно 90 дней)
2. **Задеплойте приложение** через GitHub
3. **Настройте переменные окружения**:
   - `TELEGRAM_TOKEN`
   - `WEBHOOK_URL`
   - `DATABASE_URL`
4. **Настройте cron** для проверок (cron-job.org или UptimeRobot)

## API Endpoints

### Пинг от устройства
```
GET/POST /ping?chat_id=YOUR_CHAT_ID
```

### Проверка состояния (для cron)
```
GET /check-lights
```

### Telegram Webhook
```
POST /bot<TELEGRAM_TOKEN>
```

## Telegram команды

- `/status` - показать текущее состояние света

## Настройка ESP8266/ESP32

Пример кода для отправки пингов:

```cpp
#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>

const char* ssid = "YOUR_WIFI";
const char* password = "YOUR_PASSWORD";
const char* serverUrl = "https://your-app.onrender.com/ping?chat_id=YOUR_CHAT_ID";

void setup() {
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
  }
}

void loop() {
  HTTPClient http;
  http.begin(serverUrl);
  http.GET();
  http.end();
  
  delay(30000); // 30 секунд
}
```

## Структура проекта

```
lightwrtpign/
├── server.js           # Основной файл приложения
├── package.json        # Зависимости
├── render.yaml         # Конфигурация Render
├── .env.example        # Пример переменных окружения
├── DEPLOY.md          # Инструкция по деплою
└── public/            # Статические файлы
```

## Как это работает

1. **ESP8266/ESP32** отправляет HTTP запрос каждые 30 секунд на `/ping`
2. **Сервер** обновляет время последнего пинга в базе данных
3. **Внешний cron** вызывает `/check-lights` каждую минуту
4. Если пинг не приходил **более 3 минут** → свет выключен
5. **Telegram бот** отправляет уведомление о смене состояния

## Ограничения бесплатного плана

### Render.com Free:
- ✅ 750 часов/месяц (хватает на 1 сервис 24/7)
- ⚠️ PostgreSQL удаляется через 90 дней
- ⚠️ Сервис "засыпает" после 15 минут неактивности

### Решение:
- Используйте UptimeRobot для пинга каждые 5 минут
- Через 90 дней создайте новую PostgreSQL базу

## Альтернативы для постоянной БД

Если нужна база навсегда:
- **Supabase** - 500 MB бесплатно навсегда
- **MongoDB Atlas** - 512 MB бесплатно навсегда
- **PlanetScale** - 5 GB бесплатно

## Troubleshooting

### Бот не отвечает
Проверьте webhook:
```bash
curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo
```

### База данных не подключается
Проверьте `DATABASE_URL` в переменных окружения Render

### Приложение засыпает
Настройте UptimeRobot для пинга `/check-lights` каждые 5 минут

## Лицензия

MIT

## Автор

Создано для мониторинга электричества в доме
