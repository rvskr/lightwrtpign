const { google } = require('googleapis');
const { DateTime } = require('luxon');

class SheetsDB {
    constructor(logger) {
        this.logger = logger;
        this.sheets = null;
        this.spreadsheetId = process.env.GOOGLE_SHEET_ID;
        this.sheetName = 'LightStates';
    }

    async initialize() {
        try {
            // Создаем клиента из JSON credentials
            // Обрабатываем случай когда JSON может быть многострочным
            let credentialsStr = process.env.GOOGLE_CREDENTIALS;
            
            // Если это не JSON объект, а строка - парсим
            const credentials = typeof credentialsStr === 'string' 
                ? JSON.parse(credentialsStr) 
                : credentialsStr;
            
            const auth = new google.auth.GoogleAuth({
                credentials: credentials,
                scopes: ['https://www.googleapis.com/auth/spreadsheets'],
            });

            this.sheets = google.sheets({ version: 'v4', auth });
            this.logger.info('Google Sheets API инициализирован');

            // Проверяем существование листа, если нет - создаем
            await this.ensureSheetExists();
        } catch (error) {
            this.logger.error(`Ошибка инициализации Google Sheets: ${error.message}`);
            throw error;
        }
    }

    async ensureSheetExists() {
        try {
            const response = await this.sheets.spreadsheets.get({
                spreadsheetId: this.spreadsheetId,
            });

            const sheetExists = response.data.sheets.some(
                sheet => sheet.properties.title === this.sheetName
            );

            if (!sheetExists) {
                // Создаем новый лист
                await this.sheets.spreadsheets.batchUpdate({
                    spreadsheetId: this.spreadsheetId,
                    resource: {
                        requests: [{
                            addSheet: {
                                properties: {
                                    title: this.sheetName,
                                }
                            }
                        }]
                    }
                });

                // Добавляем заголовки
                await this.sheets.spreadsheets.values.update({
                    spreadsheetId: this.spreadsheetId,
                    range: `${this.sheetName}!A1:E1`,
                    valueInputOption: 'RAW',
                    resource: {
                        values: [['chat_id', 'last_ping_time', 'light_state', 'light_start_time', 'previous_duration']]
                    }
                });

                this.logger.info(`Лист ${this.sheetName} создан с заголовками`);
            }
        } catch (error) {
            this.logger.error(`Ошибка проверки/создания листа: ${error.message}`);
            throw error;
        }
    }

    async saveLightState(chatId, lastPingTime, lightState, lightStartTime, previousDuration) {
        try {
            const row = await this.findRowByChatId(chatId);
            // Форматируем время в читаемый вид: "01.11.2025 02:44:01"
            const values = [[
                chatId,
                lastPingTime.toFormat('dd.MM.yyyy HH:mm:ss'),
                lightState ? 'TRUE' : 'FALSE', // Сохраняем как строку
                lightStartTime.toFormat('dd.MM.yyyy HH:mm:ss'),
                previousDuration ? previousDuration.toFormat("hh:mm:ss") : ''
            ]];

            if (row) {
                // Обновляем существующую строку
                await this.sheets.spreadsheets.values.update({
                    spreadsheetId: this.spreadsheetId,
                    range: `${this.sheetName}!A${row}:E${row}`,
                    valueInputOption: 'RAW',
                    resource: { values }
                });
            } else {
                // Добавляем новую строку
                await this.sheets.spreadsheets.values.append({
                    spreadsheetId: this.spreadsheetId,
                    range: `${this.sheetName}!A:E`,
                    valueInputOption: 'RAW',
                    resource: { values }
                });
            }

            this.logger.info(`Данные для chat_id ${chatId} сохранены в Google Sheets`);
        } catch (error) {
            this.logger.error(`Ошибка сохранения в Google Sheets: ${error.message}`);
            throw error;
        }
    }

    async getLightState(chatId) {
        try {
            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId: this.spreadsheetId,
                range: `${this.sheetName}!A:E`,
            });

            const rows = response.data.values;
            if (!rows || rows.length <= 1) {
                return null;
            }

            // Ищем строку с нужным chat_id (пропускаем заголовок)
            const dataRow = rows.slice(1).find(row => row[0] === chatId);
            
            if (!dataRow) {
                return null;
            }

            return {
                chat_id: dataRow[0],
                last_ping_time: dataRow[1], // Уже в читаемом формате
                light_state: dataRow[2] === 'TRUE' || dataRow[2] === 'true' || dataRow[2] === true,
                light_start_time: dataRow[3], // Уже в читаемом формате
                previous_duration: dataRow[4] || null
            };
        } catch (error) {
            this.logger.error(`Ошибка чтения из Google Sheets: ${error.message}`);
            return null;
        }
    }

    async getAllLightStates() {
        try {
            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId: this.spreadsheetId,
                range: `${this.sheetName}!A:E`,
            });

            const rows = response.data.values;
            if (!rows || rows.length <= 1) {
                return [];
            }

            // Преобразуем все строки (кроме заголовка) в объекты
            return rows.slice(1).map(row => ({
                chat_id: row[0],
                last_ping_time: row[1], // Уже в читаемом формате
                light_state: row[2] === 'TRUE' || row[2] === 'true' || row[2] === true,
                light_start_time: row[3], // Уже в читаемом формате
                previous_duration: row[4] || null
            }));
        } catch (error) {
            this.logger.error(`Ошибка чтения всех данных из Google Sheets: ${error.message}`);
            return [];
        }
    }

    async findRowByChatId(chatId) {
        try {
            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId: this.spreadsheetId,
                range: `${this.sheetName}!A:A`,
            });

            const rows = response.data.values;
            if (!rows) {
                return null;
            }

            // Ищем индекс строки (учитываем что первая строка - заголовок)
            const rowIndex = rows.findIndex((row, index) => index > 0 && row[0] === chatId);
            return rowIndex > 0 ? rowIndex + 1 : null;
        } catch (error) {
            this.logger.error(`Ошибка поиска строки: ${error.message}`);
            return null;
        }
    }
}

module.exports = SheetsDB;
