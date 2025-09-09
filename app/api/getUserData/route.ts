/**
 * Rota API: getUserData
 * ------------------------------------------------------------
 * Finalidade
 *   - Recebe um texto (número de telefone) vindo do agente Moveo,
 *     busca os dados do usuário em uma planilha do Google Sheets
 *     e devolve as instruções + variáveis de sessão para uso no chat.
 *
 * Entradas (HTTP POST /app/api/getUserData/route.ts)
 *   - Body (JSON): { "input": { "text": "<telefone ou mensagem>" }, ... }
 *     • O telefone pode vir com símbolos/espaços. A rota normaliza para dígitos.
 *
 * Saída (200 OK)
 *   - JSON no formato esperado pela Moveo:
 *     {
 *       "output": {
 *         "live_instructions": { "conteudo": "<texto de resposta para o usuário>" },
 *         "session_variables": {
 *           "user_email": "<email>",
 *           "user_phone": "<telefone>",
 *           "user_name": "<nome>"
 *         }
 *       }
 *     }
 *
 * Códigos de erro
 *   - 400: body inválido ou texto ausente.
 *   - 404: usuário não localizado na planilha.
 *   - 500: falha interna (erros de integração ou exceções inesperadas).
 *
 * Dependências
 *   - '@/lib/google' → provê o cliente `sheets` (Google Sheets API).
 *   - Variáveis de ambiente de credenciais do Google já configuradas.
 *
 * Observações de implementação
 *   - O número de telefone é limpo para conter apenas dígitos.
 *   - A busca prioriza correspondência exata (após normalização) nas colunas
 *     relacionadas a telefone/celular/phone.
 *   - Logs são enviados via `console.log`/`console.error` para depuração.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sheets } from '@/lib/google';

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        console.log("CORPO DA REQUISIÇÃO (getUserData):", JSON.stringify(body, null, 2));
        
        let phoneNumberInput = body.input.text;

        if (!phoneNumberInput || typeof phoneNumberInput !== 'string') {
            return NextResponse.json({ output: { text: "Input de texto do usuário não encontrado." } }, { status: 400 });
        }

        // Lógica para limpar e padronizar o número de telefone
        // 1. Limpa a entrada do usuário para conter apenas dígitos.
        let normalizedPhone = phoneNumberInput.replace(/\D/g, '');

        // 2. Extrai os últimos 11 dígitos como a "chave" de busca.
        // Isso funciona para "119..." e para "55119...".
        const userPhoneKey = normalizedPhone.slice(-11);

        const spreadsheetId = process.env.SHEET_ID;
        const range = 'Página1!A:C';

        const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
        const rows = response.data.values;
        if (!rows || rows.length <= 1) {
            return NextResponse.json({ output: { live_instructions: { conteudo: 'A planilha está vazia.' } } });
        }

        // --- LÓGICA DE BUSCA FLEXÍVEL ---
        const userRow = rows.slice(1).find(row => {
            const phoneFromSheet = row[1] || ''; // Pega o número da planilha

            // 3. Aplica A MESMA lógica de normalização ao dado da planilha.
            const sheetPhoneClean = phoneFromSheet.replace(/\D/g, '');
            const sheetPhoneKey = sheetPhoneClean.slice(-11);

            // 4. Compara apenas as chaves de 11 dígitos.
            return sheetPhoneKey === userPhoneKey && userPhoneKey.length === 11;
        });

        if (!userRow) {
            return NextResponse.json({ output: { live_instructions: { conteudo: 'Usuário não encontrado com este número de telefone.' } } });
        }

        const userData = { nome: userRow[0], telefone: userRow[1], email: userRow[2] };
        const formattedContent = `### Dados do Usuário\n- **Nome:** ${userData.nome}\n- **Telefone:** ${userData.telefone}\n- **Email:** ${userData.email}`;

        return NextResponse.json({
            output: {
                live_instructions: { conteudo: formattedContent },
                session_variables: {
                    user_email: userData.email,
                    user_phone: userData.telefone,
                    user_name: userData.nome
                }
            },
        });

    } catch (error: any) {
        console.error('ERRO no webhook getUserData:', error.message);
        return NextResponse.json({
            output: { live_instructions: { conteudo: 'Ocorreu um erro interno ao buscar seus dados.' } },
        }, { status: 500 });
    }
}
