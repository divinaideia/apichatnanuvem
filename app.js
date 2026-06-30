const dns = require('dns');
if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
}
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const cors = require('cors');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    delay
} = require('@whiskeysockets/baileys');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const QRCode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
    console.log(`[HTTP] 📡 ${req.method} ${req.url} - Body:`, JSON.stringify(req.body));
    next();
});

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://localhost/simulador/webhook';

// Armazena as instâncias em execução
const instances = {};

// Logger silencioso para o Baileys não inundar o terminal
const logger = pino({ level: 'silent' });

/**
 * Extrai o texto contido em qualquer formato de mensagem do Baileys
 */
function extractTextContent(message) {
    if (!message) return '';
    
    // Suporte a mensagens temporárias / visualização única
    if (message.ephemeralMessage) {
        message = message.ephemeralMessage.message;
    }
    if (message.viewOnceMessage) {
        message = message.viewOnceMessage.message;
    }
    if (message.viewOnceMessageV2) {
        message = message.viewOnceMessageV2.message;
    }
    if (!message) return '';

    return message.conversation || 
           message.extendedTextMessage?.text || 
           message.imageMessage?.caption || 
           message.videoMessage?.caption || 
           message.documentMessage?.caption || 
           '';
}

/**
 * Inicializa ou recupera uma conexão do WhatsApp
 */
async function startInstance(instanceName, resWebhookUrl = WEBHOOK_URL) {
    if (instances[instanceName] && instances[instanceName].sock) {
        return instances[instanceName];
    }

    const sessionDir = path.join(__dirname, 'sessions', instanceName);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: logger,
        browser: ['Ubuntu', 'Chrome', '124.0.0.0'],
        connectTimeoutMs: 30000,
        keepAliveIntervalMs: 30000,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false
    });

    instances[instanceName] = {
        sock,
        qrCode: null,
        status: 'initializing',
        pairingCode: null
    };

    sock.ev.on('connection.update', async (update) => {
        if (!instances[instanceName]) {
            return;
        }
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            instances[instanceName].qrCode = qr;
            instances[instanceName].status = 'qrcode';
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            instances[instanceName].status = 'disconnected';
            instances[instanceName].qrCode = null;
            
            if (shouldReconnect) {
                console.log(`[Instance ${instanceName}] Conexão fechada. Erro:`, lastDisconnect?.error, `Re-inicializando em 5 segundos...`);
                if (instances[instanceName]) {
                    instances[instanceName].sock = null;
                }
                setTimeout(() => {
                    startInstance(instanceName, resWebhookUrl);
                }, 5000);
            } else {
                console.log(`[Instance ${instanceName}] Desconectado permanentemente (Logged Out). Limpando sessão...`);
                delete instances[instanceName];
                try {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                } catch (e) {}
            }
        } else if (connection === 'open') {
            instances[instanceName].status = 'connected';
            instances[instanceName].qrCode = null;
            console.log(`[Instance ${instanceName}] Conectado com sucesso!`);
            
            // Dispara Webhook de conexão aberta para o app PHP
            triggerWebhook(resWebhookUrl, {
                event: 'connection.open',
                instance: instanceName,
                status: 'connected'
            });
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Escuta novas mensagens recebidas
    sock.ev.on('messages.upsert', async (m) => {
        console.log(`[Instance ${instanceName}] 🔔 Evento messages.upsert: tipo=${m.type}, quantidade=${m.messages?.length}`);
        if (m.type === 'notify') {
            for (const msg of m.messages) {
                console.log(`[Instance ${instanceName}] 📩 Analisando msg: fromMe=${msg.key.fromMe}, remoteJid=${msg.key.remoteJid}, hasMessage=${!!msg.message}`);
                // Filtra para responder apenas mensagens privadas (DMs) enviadas por contatos reais (incluindo o protocolo @lid)
                if (!msg.key.fromMe && msg.message && msg.key.remoteJid && (msg.key.remoteJid.endsWith('@s.whatsapp.net') || msg.key.remoteJid.endsWith('@lid'))) {
                    let from = msg.key.remoteJid.split('@')[0];
                    // Remove identificadores de múltiplos dispositivos (ex: "556693618162:1" -> "556693618162")
                    if (from.includes(':')) {
                        from = from.split(':')[0];
                    }
                    // Preserva o sufixo @lid no número para podermos responder no canal correto
                    if (msg.key.remoteJid.endsWith('@lid')) {
                        from = from + '@lid';
                    }
                    const name = msg.pushName || 'Contato WhatsApp';
                    
                    console.log(`[Instance ${instanceName}] 📩 Conteúdo da mensagem recebida:`, JSON.stringify(msg.message));
                    console.log(`[Instance ${instanceName}] 🔍 Diagnóstico do Objeto MSG:`, JSON.stringify({
                        key: msg.key,
                        pushName: msg.pushName,
                        senderPn: msg.senderPn || null,
                        participantPn: msg.participantPn || null,
                        remoteJidAlt: msg.key?.remoteJidAlt || null,
                        participantAlt: msg.key?.participantAlt || null,
                        devicePn: msg.devicePn || null,
                        phoneNumber: msg.phoneNumber || null
                    }));
                    
                    // Extrai o conteúdo de texto da mensagem usando o método auxiliar
                    const text = extractTextContent(msg.message);

                    if (text) {
                        console.log(`[Instance ${instanceName}] 📩 Mensagem Filtrada e Aprovada de ${name} (${from}): "${text}"`);
                        // Envia para o painel PHP via Webhook
                        triggerWebhook(resWebhookUrl, {
                            event: 'message.received',
                            instance: instanceName,
                            from: from,
                            name: name,
                            text: text
                        });
                    } else {
                        console.log(`[Instance ${instanceName}] ⚠️ Mensagem sem conteúdo de texto extraível.`);
                    }
                }
            }
        }
    });

    return instances[instanceName];
}

/**
 * Função para disparar Webhook para o PHP
 */
function triggerWebhook(url, payload) {
    // Extrai o ID da conta a partir de "instancia_X"
    let contaId = '1';
    if (payload.instance) {
        contaId = payload.instance.replace('instancia_', '');
    }

    console.log(`[Webhook] 📤 Disparando webhook para: ${url}`);

    // Envia assincronamente usando a API fetch nativa do Node 18+
    fetch(url, {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        },
        body: new URLSearchParams({
            conta_id: contaId,
            nome: payload.name || 'API WhatsApp',
            numero: payload.from || '',
            mensagem: payload.text || JSON.stringify(payload)
        })
    })
    .then(async (res) => {
        const text = await res.text();
        console.log(`[Webhook] 📡 Resposta do Servidor PHP (Status ${res.status}):`, text.substring(0, 300));
    })
    .catch((err) => {
        console.error(`[Webhook] ❌ Erro ao enviar webhook para ${url}:`, err.message);
    });
}

// --------------------------------------------------------------------------
// Rota de Health Check
app.get('/', (req, res) => {
    res.json({ status: 'online', message: 'Chat na Nuvem WhatsApp API Gateway rodando com sucesso!' });
});

// Rota de Diagnóstico de Rede (Verifica se a Hostinger está bloqueando a conexão)
app.get('/test-connection', async (req, res) => {
    const dns = require('dns');
    const net = require('net');
    const results = {};

    // 1. Teste DNS
    try {
        const ip = await new Promise((resolve, reject) => {
            dns.lookup('web.whatsapp.com', (err, address) => {
                if (err) reject(err);
                else resolve(address);
            });
        });
        results.dns_lookup = { status: 'success', ip };
    } catch (err) {
        results.dns_lookup = { status: 'failed', error: err.message };
    }

    // 2. Teste Conexão TCP Porta 443
    try {
        const tcpConnected = await new Promise((resolve) => {
            const socket = net.createConnection(443, 'web.whatsapp.com');
            socket.setTimeout(5000);
            socket.on('connect', () => {
                socket.destroy();
                resolve({ status: 'success' });
            });
            socket.on('timeout', () => {
                socket.destroy();
                resolve({ status: 'failed', error: 'Timeout (5 segundos)' });
            });
            socket.on('error', (err) => {
                socket.destroy();
                resolve({ status: 'failed', error: err.message });
            });
        });
        results.tcp_443 = tcpConnected;
    } catch (err) {
        results.tcp_443 = { status: 'failed', error: err.message };
    }

    // 3. Teste HTTP HEAD
    try {
        const response = await fetch('https://web.whatsapp.com', { method: 'HEAD' });
        results.http_head = { status: 'success', statusCode: response.status };
    } catch (err) {
        results.http_head = { status: 'failed', error: err.message };
    }

    res.json(results);
});

// --------------------------------------------------------------------------
// REST ROUTES
// --------------------------------------------------------------------------

// Criar/Inicializar Instância
app.post('/instance/create', async (req, res) => {
    const { instanceName, webhookUrl } = req.body;
    if (!instanceName) {
        return res.status(400).json({ error: 'instanceName é obrigatório.' });
    }

    try {
        await startInstance(instanceName, webhookUrl || WEBHOOK_URL);
        res.json({ status: 'success', message: `Instância ${instanceName} criada/iniciada.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Obter QR Code
app.get('/instance/qrcode', async (req, res) => {
    const { instanceName } = req.query;
    const instance = instances[instanceName];

    if (!instance) {
        return res.status(404).json({ error: 'Instância não encontrada ou inicializada.' });
    }

    if (instance.status === 'connected') {
        return res.json({ status: 'connected', message: 'Aparelho já está conectado.' });
    }

    if (!instance.qrCode) {
        return res.json({ status: 'waiting', message: 'Aguardando o WhatsApp gerar o QR Code...' });
    }

    try {
        const qrImage = await QRCode.toDataURL(instance.qrCode);
        res.json({ status: 'qrcode', qrcode: qrImage });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao gerar imagem do QR Code.' });
    }
});

// Obter Código de Pareamento de 8 dígitos (Alternativa ao QR Code)
app.get('/instance/pairing-code', async (req, res) => {
    const { instanceName, phoneNumber } = req.query;
    let instance = instances[instanceName];

    if (!instance) {
        return res.status(404).json({ error: 'Instância não encontrada.' });
    }

    if (!phoneNumber) {
        return res.status(400).json({ error: 'phoneNumber (DDI + DDD + Número) é obrigatório.' });
    }

    try {
        const cleanPhone = phoneNumber.replace(/\D/g, '');
        
        // Aguarda até que a conexão socket esteja aberta ou tenha gerado um QR code (limite de 10 segundos)
        let retries = 0;
        while ((!instance.sock || instance.status === 'initializing') && retries < 10) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            instance = instances[instanceName];
            retries++;
        }

        const code = await instance.sock.requestPairingCode(cleanPhone);
        res.json({ status: 'pairing_code', code: code });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao solicitar código de pareamento: ' + err.message });
    }
});

// Status da Instância
app.get('/instance/status', (req, res) => {
    const { instanceName } = req.query;
    const instance = instances[instanceName];

    if (!instance) {
        return res.json({ status: 'not_initialized' });
    }

    res.json({ status: instance.status });
});

// Deletar Instância (Desconectar e Excluir)
app.post('/instance/delete', async (req, res) => {
    const { instanceName } = req.body;
    const instance = instances[instanceName];

    if (instance) {
        try {
            instance.sock.logout();
        } catch (e) {}
        delete instances[instanceName];
    }

    const sessionDir = path.join(__dirname, 'sessions', instanceName);
    if (fs.existsSync(sessionDir)) {
        try {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        } catch (e) {}
    }

    res.json({ status: 'success', message: `Instância ${instanceName} excluída.` });
});

// Enviar Mensagem de Texto
app.post('/message/sendText', async (req, res) => {
    const { instanceName, number, text } = req.body;
    const instance = instances[instanceName];

    if (!instance || instance.status !== 'connected') {
        return res.status(400).json({ error: 'Instância não está conectada.' });
    }

    try {
        let cleanJid = number;
        if (cleanJid.includes('@')) {
            // Se já contém domínio (como @lid), usa o JID inteiro
            cleanJid = cleanJid.trim();
        } else {
            // Caso contrário, padroniza para o domínio padrão
            cleanJid = cleanJid.replace(/\D/g, '') + '@s.whatsapp.net';
        }
        const result = await instance.sock.sendMessage(cleanJid, { text: text });
        res.json({ status: 'success', messageId: result.key.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Tenta re-inicializar sessões salvas em disco ao ligar o servidor
const sessionsPath = path.join(__dirname, 'sessions');
if (fs.existsSync(sessionsPath)) {
    fs.readdirSync(sessionsPath).forEach(folder => {
        const folderPath = path.join(sessionsPath, folder);
        if (fs.lstatSync(folderPath).isDirectory()) {
            console.log(`[Autostart] Inicializando sessão salva: ${folder}`);
            startInstance(folder).catch(() => {});
        }
    });
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Gateway WhatsApp API rodando na porta http://localhost:${PORT}`);
});
