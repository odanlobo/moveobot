import OpenAI from 'openai';

// Inicializa o cliente da OpenAI uma única vez
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Usa o modelo GPT para analisar a conversa e extrair uma instrução de edição estruturada.
 * @param conversation O histórico da conversa.
 * @param userPhone O telefone ATUAL do usuário, para ser usado como chave de busca.
 * @returns Um objeto JSON com a ação a ser executada e os dados necessários.
 */
export async function getEditInstruction(conversation: string, userPhone: string): Promise<any> {
    // Se a conversa estiver vazia, retorna um erro controlado.
    if (!conversation || conversation.trim() === '') {
        console.error("Aviso: Tentativa de chamar a IA com uma conversa vazia.");
        return { action: 'error', data: { message: 'Conversa vazia.' } };
    }

    // Esta é a forma correta de chamar a API de Chat Completions
    const completion = await openai.chat.completions.create({
        model: 'gpt-5-nano', // ou o modelo que preferir
        response_format: { type: 'json_object' }, // Parâmetro correto para forçar JSON
        messages: [
            {
                role: 'system',
                content: `
                    Você é um assistente especialista em extrair uma única instrução de edição a partir de uma conversa.
                    Sua resposta DEVE ser um objeto JSON.

                    // ======================== CORREÇÃO DO PROMPT ========================
                    // Agora a IA vai gerar ações mais específicas como 'update_phone', 'update_email', etc.
                    // Isso vai corresponder diretamente aos 'cases' no seu switch.
                    Para atualizar a planilha, identifique o campo (nome, telefone ou email) e use uma das seguintes ações: "update_phone", "update_email", "update_name".
                    O campo "new_value" deve ser o novo valor extraído. O "identifier" deve ter a chave "telefone" e o valor "${userPhone}".
                    Exemplo: {"action": "update_phone", "new_value": "novo_numero", "identifier": {"key": "telefone", "value": "${userPhone}"}}
                    
                    Para criar, editar ou deletar eventos na agenda:
                    {"action": "create_event", "event": {"summary": "Título", "start": "...", "end": "..."}}
                    {"action": "update_event", "event": {"summary": "Título a ser encontrado", "start": "novo_horario_inicio"}}
                    {"action": "delete_event", "event": {"summary": "Título a ser cancelado"}}
                    
                    Analise a conversa e retorne APENAS o JSON. Se não conseguir extrair uma ação clara, retorne {"action": "unknown"}.
                `,
            },
            { role: 'user', content: conversation },
        ],
    });

    const responseContent = completion.choices[0].message.content;

    if (!responseContent) {
        throw new Error('A resposta da OpenAI estava vazia.');
    }

    try {
        return JSON.parse(responseContent);
    } catch (error) {
        console.error("Erro ao fazer o parse da resposta da IA. Resposta não era um JSON válido:", responseContent);
        throw new Error("A resposta da IA não estava no formato JSON esperado.");
    }
}