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