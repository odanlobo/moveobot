/**
* Rota API: getCalendarData
* ------------------------------------------------------------
* Finalidade
* - Receber uma instrução do agente Moveo (ex.: "mostrar agenda",
* "tenho horário amanhã às 14h?", "quais horários livres na quarta?")
* e consultar o Google Calendar para retornar um resumo de eventos
* e/ou janelas de disponibilidade.
*
* Contexto
* - O e-mail do calendário pode vir da planilha (Google Sheets) ou das
* `session_variables` já salvas na sessão da Moveo (ex.: `user_email`).
*
* Entradas (HTTP POST /app/api/getCalendarData/route.ts)
* - Body (JSON):
* {
* "input": { "text": "<mensagem do usuário>" },
* "session_variables": { "user_email": "<email opcional>" }
* }
* • `input.text` pode ser linguagem natural. A lógica deve tentar extrair
* datas/horários (ex.: hoje, amanhã, quarta 14h, etc.).
*
* Saída (200 OK)
* - JSON no formato esperado pela Moveo:
* {
* "output": {
* "live_instructions": { "conteudo": "<texto de resposta>" },
* "session_variables": {
* "calendar_email": "<email usado>",
* "last_calendar_query": "<intervalo consultado>",
* "last_calendar_result_count": <qtdEventos>
* }
* }
* }
*
* Códigos de erro
* - 400: body inválido ou sem `input.text`.
* - 404: e-mail do calendário não encontrado (nem em sessão, nem na planilha).
* - 500: falha interna (erros de integração/Google API ou exceções inesperadas).
*
* Dependências
* - '@/lib/google' → provê os clientes `calendar` e, opcionalmente, `sheets`.
* - Variáveis de ambiente do Google (credenciais) previamente configuradas.
*
* Convenções e Observações
* - Fuso horário padrão: 'America/Sao_Paulo'. Ajuste se necessário.
* - Formato do retorno SEMPRE segue o envelope da Moveo:
* output.live_instructions.conteudo
* - Não expor detalhes sensíveis de erros ao usuário.
* - Evitar dependências extras (ex.: Zod). Validar campos manualmente.
*/

import { NextRequest, NextResponse } from 'next/server';
import { calendar } from '@/lib/google';

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        console.log("CORPO DA REQUISIÇÃO (getCalendarData):", JSON.stringify(body, null, 2));

        const userEmail = body.context.session_variables.user_email;

        if (!userEmail) {
            return NextResponse.json({
                output: { live_instructions: { agenda: 'E-mail do usuário não foi passado para este webhook.' } }
            });
        }

        const response = await calendar.events.list({
            calendarId: userEmail,
            timeMin: (new Date()).toISOString(),
            maxResults: 10,
            singleEvents: true,
            orderBy: 'startTime',
        });

        const events = response.data.items;
        if (!events || events.length === 0) {
            return NextResponse.json({
                output: { live_instructions: { agenda: 'Nenhum compromisso encontrado para os próximos dias.' } },
            });
        }

        const formattedAgenda = events.map(event => {
            const start = event.start?.dateTime || event.start?.date;
            if (!start) return '';
            return `- **${event.summary}**: ${new Date(start).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`;
        }).join('\n');

        const markdownOutput = `\n### Próximos Compromissos\n${formattedAgenda}`;

        return NextResponse.json({
            output: { live_instructions: { agenda: markdownOutput } },
        });

    } catch (error: any) {
        console.error('ERRO no webhook getCalendarData:', error.message);
        if (error.code === 404) {
            return NextResponse.json({
                output: { live_instructions: { agenda: 'Não consegui acessar sua agenda. Verifique se ela foi compartilhada corretamente com o e-mail da Service Account.' } },
            });
        }
        return NextResponse.json({
            output: { live_instructions: { agenda: 'Ocorreu um erro interno ao buscar a agenda.' } },
        }, { status: 500 });
    }
}
