# Деплой на Render.com

## 1. Настройка Google Sheets API

Следуйте инструкции в [GOOGLE_SHEETS_SETUP.md](./GOOGLE_SHEETS_SETUP.md)

## 2. Деплой приложения

1. Загрузите код на GitHub
2. На Render.com: **New+** → **Web Service**
3. Подключите GitHub репозиторий
4. Настройки:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free

## 3. Переменные окружения

Добавьте в Environment Variables:
- `TELEGRAM_TOKEN` - токен от @BotFather
- `WEBHOOK_URL` - `https://your-app.onrender.com`
- `GOOGLE_SHEET_ID` - ID Google таблицы
- `GOOGLE_CREDENTIALS` - JSON credentials в одну строку

## 4. Настройка Cron

Настройте внешний сервис для вызовов `/check-lights` каждые 5 минут:
- **UptimeRobot**: HTTP монитор на `https://your-app.onrender.com/check-lights`
- **cron-job.org**: URL `https://your-app.onrender.com/check-lights`

## Проверка

1. Откройте приложение: `https://your-app.onrender.com`
2. Проверьте логи в Render Dashboard
3. Отправьте `/status` в Telegram боте
4. Тестовый пинг: `curl "https://your-app.onrender.com/ping?chat_id=YOUR_CHAT_ID"`

## Получение Chat ID

1. Напишите боту в Telegram
2. Откройте: `https://api.telegram.org/bot<TOKEN>/getUpdates`
3. Найдите `"chat":{"id": 123456789}`
