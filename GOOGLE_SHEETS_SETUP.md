# Настройка Google Sheets API

## 1. Создание проекта

1. Перейдите в [Google Cloud Console](https://console.cloud.google.com/)
2. Создайте новый проект

## 2. Включение API

1. **APIs & Services** → **Library**
2. Найдите **Google Sheets API**
3. Нажмите **Enable**

## 3. Service Account

1. **APIs & Services** → **Credentials**
2. **Create Credentials** → **Service Account**
3. Название: `light-monitor-bot`
4. **Create and Continue** (пропустите роль)

## 4. Создание ключа

1. В списке Service Accounts нажмите на созданный
2. Вкладка **Keys** → **Add Key** → **Create new key**
3. Формат: **JSON**
4. **Сохраните файл** - он понадобится

## 5. Google Таблица

1. Создайте новую таблицу в [Google Sheets](https://sheets.google.com)
2. Скопируйте ID из URL: `https://docs.google.com/spreadsheets/d/[ID]/edit`

## 6. Предоставление доступа

1. В таблице: **Share**
2. Вставьте email из JSON (`client_email`)
3. Роль: **Editor**
4. **Share** (без уведомлений)

## Переменные окружения

```env
GOOGLE_SHEET_ID=ваш_id_таблицы
GOOGLE_CREDENTIALS={"type":"service_account",...}
```

**Важно**: `GOOGLE_CREDENTIALS` должен быть весь JSON в одну строку без переносов.
