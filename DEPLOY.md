# Инструкция по деплою на Render.com

## Что изменилось:
- ✅ Заменили Supabase на PostgreSQL (бесплатно 90 дней)
- ✅ Telegram polling → webhooks (экономит ресурсы)
- ✅ setInterval → внешний endpoint `/check-lights` (вызывается cron)

## Шаг 1: Создание PostgreSQL базы данных на Render

1. Зайдите на [render.com](https://render.com) и войдите/зарегистрируйтесь
2. Нажмите **"New +"** → **"PostgreSQL"**
3. Заполните:
   - **Name**: `light-monitor-db`
   - **Database**: `light_monitor`
   - **User**: `light_monitor_user`
   - **Region**: выберите ближайший
   - **Plan**: **Free** (90 дней бесплатно)
4. Нажмите **"Create Database"**
5. **Сохраните Internal Database URL** - он понадобится

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
   - `DATABASE_URL` = Internal Database URL из Шага 1

6. Нажмите **"Create Web Service"**

### Вариант B: Через render.yaml (автоматический)

1. Загрузите код на GitHub
2. На Render нажмите **"New +"** → **"Blueprint"**
3. Подключите репозиторий
4. Render автоматически создаст базу данных и приложение
5. Добавьте только переменные:
   - `TELEGRAM_TOKEN`
   - `WEBHOOK_URL`

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

### ⚠️ Ограничения Free плана Render:
- PostgreSQL удаляется через **90 дней**
- Сервис "засыпает" после 15 минут неактивности
- 750 часов/месяц (достаточно для 1 сервиса 24/7)

### 🔄 Что делать через 90 дней:
1. Создайте новую PostgreSQL базу
2. Обновите `DATABASE_URL` в переменных окружения
3. Данные из старой базы будут потеряны (сделайте бэкап если нужно)

### 📊 Альтернатива для постоянной БД:
- **Supabase** (500 MB бесплатно навсегда) - можно вернуться
- **MongoDB Atlas** (512 MB бесплатно навсегда)
- **PlanetScale** (5 GB бесплатно)

## Endpoints приложения

- `GET/POST /ping?chat_id=XXX` - пинг от устройства
- `GET /check-lights` - проверка состояния (вызывается cron)
- `POST /bot<TOKEN>` - webhook для Telegram
- `/status` - команда в Telegram боте

## Troubleshooting

### Бот не отвечает:
- Проверьте `TELEGRAM_TOKEN` в переменных окружения
- Проверьте webhook: `https://api.telegram.org/bot<TOKEN>/getWebhookInfo`

### База данных не подключается:
- Проверьте `DATABASE_URL` в переменных окружения
- Убедитесь что база создана и активна

### Приложение "засыпает":
- Настройте UptimeRobot для пинга каждые 5 минут
- Или используйте платный план Render ($7/месяц)
