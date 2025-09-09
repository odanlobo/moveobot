import { google } from 'googleapis';

// Autenticação centralizada para todas as APIs do Google
const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_CREDENTIALS_PATH,
    scopes: [
        'https://www.googleapis.com/auth/spreadsheets', // Permissão de leitura e escrita para Sheets
        'https://www.googleapis.com/auth/calendar'       // Permissão de leitura e escrita para Calendar
    ],
});

// Exporta uma instância já autenticada do cliente do Google Sheets
export const sheets = google.sheets({ version: 'v4', auth });

// Exporta uma instância já autenticada do cliente do Google Calendar
export const calendar = google.calendar({ version: 'v3', auth });