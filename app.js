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

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://localhost/simulador/webhook';

// Armazena as instâncias em execução
const instances = {};

// Logger silencioso para o Baileys não inundar o terminal
const logger = pino({ level: 'silent' });

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
        if (m.type === 'notify') {
            for (const msg of m.messages) {
                if (!msg.key.fromMe && msg.message) {
                    const from = msg.key.remoteJid.split('@')[0];
                    const name = msg.pushName || 'Contato WhatsApp';
                    let text = '';

                    if (msg.message.conversation) {
                        text = msg.message.conversation;
                    } else if (msg.message.extendedTextMessage?.text) {
                        text = msg.message.extendedTextMessage.text;
                    }

                    if (text) {
                        // Envia para o painel PHP via Webhook
                        triggerWebhook(resWebhookUrl, {
                            event: 'message.received',
                            instance: instanceName,
                            from: from,
                            name: name,
                            text: text
                        });
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
    // Envia assincronamente usando a API fetch nativa do Node 18+ (sem requisições externas de pacotes)
    fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            conta_id: url.includes('/simulador/webhook') ? '1' : '', // Ajuste de conveniência
            nome: payload.name || 'API WhatsApp',
            numero: payload.from || '',
            mensagem: payload.text || JSON.stringify(payload)
        })
    }).catch(() => {});
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
        const cleanJid = number.replace(/\D/g, '') + '@s.whatsapp.net';
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
