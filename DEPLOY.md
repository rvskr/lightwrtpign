# Инструкция по деплою на Render.com

## Что изменилось:
- ✅ Заменили Supabase на **Google Sheets** (бесплатно навсегда!)
- ✅ Telegram polling → webhooks (экономит ресурсы)
- ✅ setInterval → внешний endpoint `/check-lights` (вызывается cron)

## Шаг 1: Настройка Google Sheets API

**Следуйте подробной инструкции в файле [GOOGLE_SHEETS_SETUP.md](./GOOGLE_SHEETS_SETUP.md)**

Краткая версия:
1. Создайте проект в Google Cloud Console
2. Включите Google Sheets API
3. Создайте Service Account и скачайте JSON ключ
4. Создайте Google Таблицу и предоставьте доступ Service Account
5. Сохраните:
   - `GOOGLE_SHEET_ID` (из URL таблицы)
   - `GOOGLE_CREDENTIALS` (содержимое JSON файла в одну строку)

## Шаг 2: Деплой приложения на Render

### Вариант A: Через GitHub (рекомендуется)

1. Загрузите код на GitHub:
   ```bash
   git add .
   git commit -m "Migrate to Render with PostgreSQL"
   git push origin main
   ```

2. На Render нажмите **"New +"** → **"Web Service"**
3. Подключите ваш GitHub репозиторий
4. Заполните:
   - **Name**: `light-monitor`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: **Free**

5. Добавьте переменные окружения (**Environment Variables**):
   - `TELEGRAM_TOKEN` = ваш токен от @BotFather
   - `WEBHOOK_URL` = `https://light-monitor.onrender.com` (замените на ваш URL)
   - `GOOGLE_SHEET_ID` = ID вашей Google Таблицы
   - `GOOGLE_CREDENTIALS` = JSON credentials в одну строку

6. Нажмите **"Create Web Service"**

### Вариант B: Через render.yaml (автоматический)

1. Загрузите код на GitHub
2. На Render нажмите **"New +"** → **"Blueprint"**
3. Подключите репозиторий
4. Render автоматически создаст приложение
5. Добавьте переменные:
   - `TELEGRAM_TOKEN`
   - `WEBHOOK_URL`
   - `GOOGLE_SHEET_ID`
   - `GOOGLE_CREDENTIALS`

## Шаг 3: Настройка внешнего Cron для проверок

Так как Render Free может "засыпать", используем внешний сервис для проверок каждые 30 секунд:

### Вариант 1: cron-job.org (бесплатно)

1. Зайдите на [cron-job.org](https://cron-job.org)
2. Зарегистрируйтесь
3. Создайте новый Cronjob:
   - **Title**: Light Monitor Check
   - **URL**: `https://your-app.onrender.com/check-lights`
   - **Schedule**: Every 1 minute (минимум для бесплатного плана)
4. Сохраните

### Вариант 2: UptimeRobot (бесплатно)

1. Зайдите на [uptimerobot.com](https://uptimerobot.com)
2. Создайте новый монитор:
   - **Monitor Type**: HTTP(s)
   - **URL**: `https://your-app.onrender.com/check-lights`
   - **Monitoring Interval**: 5 minutes (минимум для бесплатного)

⚠️ **Важно**: Бесплатные cron сервисы не поддерживают интервал 30 секунд. Минимум 1-5 минут.

## Шаг 4: Проверка работы

1. Откройте ваше приложение: `https://your-app.onrender.com`
2. Проверьте логи в Render Dashboard
3. Отправьте `/status` в Telegram боте
4. Отправьте тестовый пинг:
   ```bash
   curl "https://your-app.onrender.com/ping?chat_id=YOUR_CHAT_ID"
   ```

## Получение Chat ID для Telegram

1. Добавьте бота в группу или напишите ему
2. Отправьте любое сообщение
3. Откройте: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
4. Найдите `"chat":{"id": 123456789}` - это ваш chat_id

## Обновление кода

```bash
git add .
git commit -m "Update"
git push origin main
```

Render автоматически задеплоит изменения.

## Важные замечания

### ✅ Преимущества Google Sheets:
- **Бесплатно навсегда!** Никаких ограничений по времени
- **Визуальный доступ** - можете смотреть данные прямо в таблице
- **Автоматический бэкап** - Google сохраняет версии
- **Простота** - не нужно настраивать базу данных

### ⚠️ Ограничения Free плана Render:
- Сервис "засыпает" после 15 минут неактивности
- 750 часов/месяц (достаточно для 1 сервиса 24/7)

### 📊 Ограничения Google Sheets API:
- 100 запросов в 100 секунд (достаточно для вашего приложения)
- 10 миллионов ячеек максимум (хватит на годы данных)

## Endpoints приложения

- `GET/POST /ping?chat_id=XXX` - пинг от устройства
- `GET /check-lights` - проверка состояния (вызывается cron)
- `POST /bot<TOKEN>` - webhook для Telegram
- `/status` - команда в Telegram боте

## Troubleshooting

### Бот не отвечает:
- Проверьте `TELEGRAM_TOKEN` в переменных окружения
- Проверьте webhook: `https://api.telegram.org/bot<TOKEN>/getWebhookInfo`

### Google Sheets не подключается:
- Проверьте `GOOGLE_SHEET_ID` и `GOOGLE_CREDENTIALS`
- Убедитесь что Service Account имеет доступ к таблице
- Проверьте что Google Sheets API включен в проекте

### Приложение "засыпает":
- Настройте UptimeRobot для пинга каждые 5 минут
- Или используйте платный план Render ($7/месяц)
