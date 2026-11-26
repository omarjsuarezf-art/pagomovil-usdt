require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const rateLimit = require('express-rate-limit');
const { open } = require('sqlite');
const sqlite3Internal = require('sqlite3');
const { Resend } = require('resend');
const { ethers } = require('ethers');
// Configuración de Resend limpia
const resend = new Resend(process.env.RESEND_API_KEY);

// Función para generar la cartera de Polygon al vuelo
function generarWalletIndividual() {
    const wallet = ethers.Wallet.createRandom();
    return {
        address: wallet.address,
        privatekey: wallet.privateKey
    };
}

const app = express();
// MAPA EN MEMORIA PARA RECUPERACIÓN DE PIN CON CÓDIGOS OTP (EXPIRAN EN 5 MINUTOS)
const codigosRecuperacion = new Map();

// Requerido por Railway/Render para lectura de IPs tras proxy
app.set('trust proxy', 1);

// Middleware
app.use(express.json());

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({ success: false, message: "JSON inválido o cuerpo vacío en la petición." });
  }
  return next(err);
});
app.use(express.urlencoded({ extended: true }));

let db;

// ==========================================
// FUNCIÓN AUXILIAR DE ENVÍO DE CORREOS CON RESEND
// ==========================================
async function enviarCorreoResend(destino, asunto, mensajeHtml) {
    try {
        const respuesta = await resend.emails.send({
            from: 'PagoMovil USDT <no-reply@pagomovilusdt.com>',
            to: [destino],
            subject: asunto,
            html: mensajeHtml
        });
        if (respuesta.error) { console.error("❌ Error Resend API:", JSON.stringify(respuesta.error)); return false; } console.log("✅ Correo de Resend enviado con éxito. ID:", respuesta.data?.id || respuesta.id); return true;
    } catch (err) {
        console.error('⚠️ Error al enviar correo vía Resend:', err.message);
        return false;
    }
}


// ==========================================
// CONFIGURACIÓN DE BASE DE DATOS (SQLITE ASÍNCRONO OPTIMIZADO)
// ==========================================
async function inicializarBaseDatos() {
    try {
        const dbPath = path.resolve(__dirname, 'monedero.db');
        db = await open({
            filename: dbPath,
            driver: sqlite3Internal.Database
        });

        console.log('Conectado a la base de datos SQLite exitosamente.');

        // Inicializar tablas completas y comercio por defecto
        await db.exec(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                telefono TEXT UNIQUE,
                pinSeguridad TEXT,
                accountType TEXT DEFAULT 'natural',
                dailyLimit REAL DEFAULT 1000.00,
                upgradedAt TEXT
            );

            CREATE TABLE IF NOT EXISTS wallets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                usdt_balance REAL DEFAULT 0.00,
                FOREIGN KEY(user_id) REFERENCES usuarios(id)
            );

            CREATE TABLE IF NOT EXISTS transacciones (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                referencia TEXT,
                monto REAL,
                telefonoEmisor TEXT,
                telefonoDestino TEXT,
                reference_hash TEXT UNIQUE,
                fechaHora TEXT
            );

            CREATE TABLE IF NOT EXISTS metodos_pago (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cedulaTitular TEXT,
                metodo TEXT,
                cuentaDestino TEXT,
                fechaRegistro TEXT
            );

            CREATE TABLE IF NOT EXISTS comisiones (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tipo TEXT,
                monto REAL,
                referencia TEXT,
                fechaHora TEXT
            );
        `);

        // Asegurar columnas opcionales si no existen
        try { await db.exec("ALTER TABLE usuarios ADD COLUMN merchant_id TEXT;"); } catch (e) {}
        try { await db.exec("ALTER TABLE usuarios ADD COLUMN metodoVinculado INTEGER DEFAULT 0;"); } catch (e) {}
        
        // Columnas para la billetera criptográfica única y permanente del usuario
        try { await db.exec("ALTER TABLE usuarios ADD COLUMN assigned_wallet TEXT;"); } catch (e) {}
        try { await db.exec("ALTER TABLE usuarios ADD COLUMN private_key TEXT;"); } catch (e) {}

        // REGLA DE ORO: Índice único para que SQLite prohíba 100% que dos usuarios tengan la misma wallet
        try {  
            await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_wallet ON usuarios(assigned_wallet);");  
        } catch (e) {}

    } catch (err) {
        console.error('❌ Error al inicializar SQLite:', err.message);
    }
}

inicializarBaseDatos();

// ==========================================
// CONFIGURACIÓN DE RATE LIMITING (SEGURIDAD DIFERENCIADA)
// ==========================================
const obtenerIpSegura = (req) => {
    const rawIp = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip || '0.0.0.0';
    return String(rawIp).split(',')[0].trim();
};

const limiterPagos = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 30,
    keyGenerator: obtenerIpSegura,
    validate: false,
    message: { 
        success: false, 
        message: 'Demasiadas solicitudes procesadas. Por seguridad intente de nuevo más tarde.' 
    },
    standardHeaders: true,
    legacyHeaders: false,
});

const limiterRegistroBot = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    keyGenerator: obtenerIpSegura,
    validate: false,
    message: {
        success: false,
        message: 'Demasiados intentos de registro desde esta conexión. Intente más tarde.'
    },
    standardHeaders: true,
    legacyHeaders: false,
});

const limiterConsultasComercio = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 120,
    keyGenerator: obtenerIpSegura,
    validate: false,
    standardHeaders: true,
    legacyHeaders: false,
});

const limiterGeneral = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    keyGenerator: obtenerIpSegura,
    validate: false
});

app.use(limiterGeneral);

const publicPath = path.resolve(__dirname, 'frontend', 'public');
app.use(express.static(publicPath));
app.use('/public', express.static(publicPath));

// ==========================================
// PARÁMETROS Y TARIFAS DE PLATAFORMA (POLYGON RED ÚNICA)
// ==========================================
const BINANCE_COMMISSION_WALLET = process.env.BINANCE_COMMISSION_WALLET || 'Binance Pay / Wallet ID';
const POLYGON_USDT_CONTRACT = '0xc2132d05d31c914a87c6611c10748aeb04b58e2f'; // USDT oficial en Polygon
const PLATFORM_POLYGON_WALLET = (process.env.PLATFORM_POLYGON_WALLET || '').toLowerCase(); // Tu wallet receptor oficial en Polygon

const COMISION_FIJA_USUARIO = 1.00;         
const COMISION_PORCENTAJE_COMERCIO = 0.015;  // 3%
const COMISION_MINIMA_COMERCIO = 2.00;      // Mínimo $2.00 USDT
const COSTO_CAMBIO_PLAN_COMERCIAL = 5.00;

const MONTO_MINIMO_RECARGA = 5.00;
const PORCENTAJE_RECARGA = 0.015; 
const MINIMO_COMISION_RECARGA = 1.00;

const PORCENTAJE_RETIRO = 0.015;  
const MINIMO_COMISION_RETIRO = 1.00;

function calcularComisionComercio(montoVenta) {
    let comisionCalculada = parseFloat(montoVenta) * COMISION_PORCENTAJE_COMERCIO;
    return comisionCalculada < COMISION_MINIMA_COMERCIO ? COMISION_MINIMA_COMERCIO : Number(comisionCalculada.toFixed(2));
}

function calcularComisionRecarga(monto) {
    let comisionCalculada = parseFloat(monto) * PORCENTAJE_RECARGA;
    return comisionCalculada < MINIMO_COMISION_RECARGA ? MINIMO_COMISION_RECARGA : Number(comisionCalculada.toFixed(2));
}

function calcularComisionRetiro(monto) {
    let comisionCalculada = parseFloat(monto) * PORCENTAJE_RETIRO;
    return comisionCalculada < MINIMO_COMISION_RETIRO ? MINIMO_COMISION_RETIRO : Number(comisionCalculada.toFixed(2));
} 

// ==========================================
// VALIDADOR AUTOMÁTICO BLOCKCHAIN (HTTP DIRECTO)
// ==========================================
async function consultarSaldoUsdtPolygon(walletAddress) {
  return new Promise((resolve) => {
    if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress.trim())) {
      return resolve({ ok: false, saldo: 0, mensaje: "Cartera Polygon asignada no válida." });
    }
    const cleanAddr = walletAddress.trim().toLowerCase().replace(/^0x/, "").padStart(64, "0");
    const callData = "0x70a08231" + cleanAddr;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_call",
      params: [{ to: "0xc2132D05D31c914a87C6611C10748AECB3329081", data: callData }, "latest"],
      id: 1
    });
    const req = https.request({
      hostname: "polygon-mainnet.g.alchemy.com",
      path: "/v2/alh_QXifklhC8Iqox8-9wTbcR",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
    }, (res) => {
      let body = "";
      res.on("data", (ch) => (body += ch));
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          if (!json.result || json.result === "0x") {
            return resolve({ ok: true, saldo: 0, mensaje: "Saldo 0 en Polygon." });
          }
          const rawUnits = BigInt(json.result);
          const saldoUsdt = Number(rawUnits) / 1e6;
          return resolve({ ok: true, saldo: saldoUsdt, mensaje: "Saldo consultado en Polygon." });
        } catch (e) {
          return resolve({ ok: false, saldo: 0, mensaje: "Error leyendo respuesta de Polygon." });
        }
      });
    });
    req.on("error", () => resolve({ ok: false, saldo: 0, mensaje: "Error de red consultando Polygon." }));
    req.write(payload);
    req.end();
  });
}

async function verificarHashPolygonEnBlockchain(txHash, montoEsperadoMinimo) {
    return new Promise((resolve) => {
        if (!txHash || txHash.trim().length < 10) {
            return resolve({ valido: false, mensaje: '❌ Hash de transacción de Polygon inválido.' });
        }

        const cleanHash = txHash.trim().startsWith('0x') ? txHash.trim() : `0x${txHash.trim()}`;
        const https = require('https');
        const data = JSON.stringify({
            jsonrpc: '2.0',
            method: 'eth_getTransactionReceipt',
            params: [cleanHash],
            id: 1
        });

        const reqOptions = {
            hostname: 'polygon-mainnet.g.alchemy.com',
            path: '/v2/alh_QXifklhC8Igox8-9wTbcR',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': data.length
            }
        };

        const req = https.request(reqOptions, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try {
                    const responseJson = JSON.parse(body);
                    const receipt = responseJson.result;
                    if (receipt && receipt.status === '0x1') {
                        return resolve({ valido: true, mensaje: '✅ Transacción verificada correctamente en Polygon.' });
                    } else {
                        return resolve({ valido: false, mensaje: '❌ La transacción falló o aún no está confirmada.' });
                    }
                } catch (err) {
                    return resolve({ valido: false, mensaje: '❌ Error procesando respuesta de la blockchain.' });
                }
            });
        });

        req.on('error', (e) => {
            console.error("⚠️ Error de conexión con Alchemy:", e.message);
            return resolve({ valido: false, mensaje: '❌ Error de red consultando la blockchain.' });
        });

        req.write(data);
        req.end();
    });
}


// ==========================================
// FUNCIÓN ÚNICA Y SEGURA DE ENVÍO POR GREEN-API
// ==========================================
function formatearNumeroWhatsapp(numero) {
    if (!numero) return null;
    let numLimpio = numero.toString().trim().replace(/\D/g, '');
    if (numLimpio.startsWith('0')) {
        numLimpio = numLimpio.substring(1);
    }
    return numLimpio;
}

async function enviarMensajeWhatsappSeguro(numero, mensaje) {
  const idInstance = process.env.GREEN_API_ID_INSTANCE;
  const apiTokenInstance = process.env.GREEN_API_TOKEN_INSTANCE;

  if (!idInstance || !apiTokenInstance) {
    console.error("⚠️ Credenciales de Green-API no configuradas en el archivo .env");
    return false;
  }

  try {
    let numLimpio = formatearNumeroWhatsapp(numero);
    if (!numLimpio) {
      console.warn("⚠️ Número inválido o vacío para WhatsApp:", numero);
      return false;
    }

    let chatId = numLimpio.startsWith("58") ? `${numLimpio}@c.us` : `58${numLimpio}@c.us`;

    const data = JSON.stringify({
      chatId: chatId,
      message: mensaje
    });

    const serverPrefix = idInstance.toString().substring(0, 4);

    const options = {
      hostname: `${serverPrefix}.api.green-api.com`,
      port: 443,
      path: `/waInstance${idInstance}/sendMessage/${apiTokenInstance}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data)
      },
      timeout: 15000
    };

    return await new Promise((resolve) => {
      const req = https.request(options, (res) => {
        let responseBody = "";
        res.on("data", (chunk) => { responseBody += chunk; });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`✅ Mensaje de Green-API enviado con éxito a ${chatId} | Respuesta:`, responseBody);
            resolve(true);
          } else {
            console.error(`⚠️ Error al enviar Whatsapp vía Green-API (${res.statusCode}) a ${chatId}:`, responseBody);
            resolve(false);
          }
        });
      });

      req.on("timeout", () => {
        console.error(`⚠️ Timeout al enviar Whatsapp vía Green-API a ${chatId}`);
        req.destroy();
        resolve(false);
      });

      req.on("error", (e) => {
        console.error(`⚠️ Excepción de red al enviar mensaje WhatsApp a ${chatId}:`, e.message);
        resolve(false);
      });

      req.write(data);
      req.end();
    });
  } catch (e) {
    console.error("⚠️ Excepción al enviar mensaje WhatsApp:", e.message);
    return false;
  }
}

function obtenerAdminPass() {
  if (process.env.ADMIN_PANEL_PASS && process.env.ADMIN_PANEL_PASS.trim()) {
    return process.env.ADMIN_PANEL_PASS.trim();
  }
  try {
    const envRaw = fsAdmin.readFileSync(envFilePath, 'utf8');
    const m = envRaw.match(/^ADMIN_PANEL_PASS=(.*)$/m);
    if (m && m[1].trim()) {
      process.env.ADMIN_PANEL_PASS = m[1].trim();
      return process.env.ADMIN_PANEL_PASS;
    }
  } catch (_) {}
  return '';
}

function guardarAdminPass(nuevaClave) {
  const limpia = String(nuevaClave || '').trim();
  if (!limpia) return false;
  process.env.ADMIN_PANEL_PASS = limpia;
  try {
    let envRaw = fsAdmin.existsSync(envFilePath) ? fsAdmin.readFileSync(envFilePath, 'utf8') : '';
    if (/^ADMIN_PANEL_PASS=/m.test(envRaw)) {
      envRaw = envRaw.replace(/^ADMIN_PANEL_PASS=.*$/m, `ADMIN_PANEL_PASS=${limpia}`);
    } else {
      envRaw = envRaw.trimEnd() + `\nADMIN_PANEL_PASS=${limpia}\n`;
    }
    fsAdmin.writeFileSync(envFilePath, envRaw, 'utf8');
  } catch (_) {}
  return true;
}

function verificarClaveAdmin(req, res, next) {
  const claveConfigurada = obtenerAdminPass();
  const claveEnviada = String(req.headers['x-admin-pass'] || req.query.adminPass || '').trim();
  if (!claveConfigurada) {
    return res.status(401).json({ success: false, needsSetup: true, message: 'Configura tu clave de administrador para acceder.' });
  }
  if (!claveEnviada || claveEnviada !== claveConfigurada) {
    return res.status(401).json({ success: false, message: 'Clave de administrador incorrecta.' });
  }
  return next();
}

app.post('/api/admin/auth/setup', (req, res) => {
  const actual = obtenerAdminPass();
  const { nuevaClave, claveActual } = req.body || {};
  if (!nuevaClave || String(nuevaClave).trim().length < 4) {
    return res.status(400).json({ success: false, message: 'La clave debe tener al menos 4 caracteres.' });
  }
  if (actual && String(claveActual || '').trim() !== actual) {
    return res.status(401).json({ success: false, message: 'Clave actual incorrecta.' });
  }
  guardarAdminPass(nuevaClave);
  return res.json({ success: true, message: 'Clave de administrador guardada.' });
});

app.post('/api/admin/auth/verificar', verificarClaveAdmin, (req, res) => {
  return res.json({ success: true });
});

app.get('/api/admin/balance', verificarClaveAdmin, async (req, res) => {
  try {
    const rowWallets = await db.get('SELECT SUM(CASE WHEN typeof(usdt_balance) IN ("integer","real") AND isfinite(usdt_balance) THEN usdt_balance ELSE 0 END) AS totalUsuarios FROM wallets');
    const rowBinance = await db.get("SELECT SUM(CASE WHEN typeof(monto) IN ('integer','real') AND isfinite(monto) THEN monto ELSE 0 END) AS totalBinance FROM comisiones WHERE tipo = 'binance'");

    const rawSaldo = Number(rowWallets && rowWallets.totalUsuarios);
    const rawGanancia = Number(rowBinance && rowBinance.totalBinance);
    const saldoUsuarios = Number.isFinite(rawSaldo) ? rawSaldo : 0;
    const gananciaBinance = Number.isFinite(rawGanancia) ? rawGanancia : 0;

    res.json({
      success: true,
      saldoUsuarios: saldoUsuarios.toFixed(2),
      gananciaBinance: gananciaBinance.toFixed(2),
      totalGanancias: gananciaBinance.toFixed(2)
    });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// NUEVO: RUTA DE LISTADO Y CONTEO DE USUARIOS PARA EL PANEL ADMIN
app.get('/api/admin/usuarios', verificarClaveAdmin, async (req, res) => {
    try {
        const rows = await db.all(`
            SELECT usuarios.id, usuarios.telefono, usuarios.accountType, usuarios.merchant_id, usuarios.respaldo_completado, usuarios.respaldo_fecha, wallets.usdt_balance 
            FROM usuarios 
            LEFT JOIN wallets ON usuarios.id = wallets.user_id 
            WHERE COALESCE(usuarios.telefono, '') NOT LIKE 'BOT_%' 
            ORDER BY usuarios.id DESC
        `);
        res.json({ success: true, usuarios: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/saldo/:telefono', limiterConsultasComercio, async (req, res) => {
    const busqueda = (req.params.telefono || '').trim();

    try {
        const row = await db.get(`
            SELECT usuarios.telefono, usuarios.merchant_id, usuarios.accountType, usuarios.dailyLimit, usuarios.metodoVinculado, wallets.usdt_balance
            FROM usuarios
            LEFT JOIN wallets ON usuarios.id = wallets.user_id
            WHERE usuarios.telefono = ? OR usuarios.merchant_id = ?
        `, [busqueda, busqueda]);

        if (!row) {
            return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
        }

        res.json({
            success: true,
            telefono: row.telefono,
            merchantId: row.merchant_id,
            accountType: row.accountType,
            dailyLimit: row.dailyLimit || 1000.00,
            saldoUSDT: row.usdt_balance || 0.00,
            metodoVinculado: row.metodoVinculado === 1
        });
    } catch (err) {
        console.error("Error consultando saldo:", err.message);
        return res.status(500).json({ success: false, message: 'Error interno al consultar saldo.' });
    }
});

// ==========================================
// RUTA OFICIAL DE INICIO DE SESIÓN POR PIN (CON SOPORTE DE PIN TEMPORAL DE 6 DÍGITOS Y BLOQUEO CERO TERCEROS)
// ==========================================
app.post('/api/login', limiterPagos, async (req, res) => {
    const telefono = (req.body.telefono || req.body.telefonoUsuario || '').trim();
    const pinSeguridad = (req.body.pinSeguridad || '').trim();

    if (!telefono || !pinSeguridad) {
        return res.status(400).json({ success: false, message: '⚠️ El teléfono y el PIN son obligatorios.' });
    }

    try {
        const usuario = await db.get('SELECT * FROM usuarios WHERE telefono = ? OR merchant_id = ?', [telefono, telefono]);
        if (!usuario) {
            return res.status(404).json({ success: false, message: '❌ El número no está registrado. Complete primero su registro y vinculación abajo (Cédula, Método y Correo/Cuenta) para crear su cuenta.' });
        }

        // VALIDACIÓN DE PIN: Soporta PIN fijo de 4 dígitos O PIN temporal de 6 dígitos activo en memoria
        let pinValido = false;
        if (pinSeguridad.length === 6) {
            const registroOTP = codigosRecuperacion.get(usuario.telefono);
            if (registroOTP && registroOTP.otp === pinSeguridad && (Date.now() - registroOTP.timestamp <= 5 * 60 * 1000)) {
                pinValido = true;
                codigosRecuperacion.delete(usuario.telefono); // Limpiar OTP usado
            }
        }
        
        if (!pinValido && usuario.pinSeguridad && usuario.pinSeguridad === pinSeguridad) {
            pinValido = true;
        }

        if (!pinValido) {
            return res.status(401).json({ success: false, message: '❌ PIN de seguridad incorrecto o código temporal expirado.' });
        }

        // VALIDACIÓN CERO TERCEROS: Verificar que posea método o monedero de recepción vinculado
        const esComercio = usuario.accountType === 'comercial' || usuario.accountType === 'emprendedor';
        if (usuario.metodoVinculado !== 1 && !esComercio) {
            return res.status(403).json({
                success: false,
                bloqueoRegistro: true,
                message: '❌ Acceso restringido. Para continuar, complete abajo su Cédula, Método/Exchange y Correo/Cuenta de recepción.',
                telefono: usuario.telefono
            });
        }

        res.json({ 
            success: true, 
            message: '¡Acceso autorizado!',
            telefono: usuario.telefono,
            accountType: usuario.accountType,
            merchantId: usuario.merchant_id,
            metodoVinculado: true
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: '❌ Error interno al procesar el inicio de sesión.' });
    }
});

// ==========================================
// RUTA OFICIAL PARA CAMBIO DE PIN DE SEGURIDAD
// ==========================================
app.post('/api/cambiar-pin', limiterPagos, async (req, res) => {
    const telefono = (req.body.telefono || '').trim();
    const pinActual = (req.body.pinActual || '').trim();
    const pinNuevo = (req.body.pinNuevo || '').trim();

    if (!telefono || !pinActual || !pinNuevo) {
        return res.status(400).json({ success: false, message: '⚠️ Todos los campos son obligatorios para cambiar el PIN.' });
    }

    if (pinNuevo.length !== 4) {
        return res.status(400).json({ success: false, message: '⚠️ El nuevo PIN debe ser estrictamente de 4 dígitos.' });
    }

    try {
        const usuario = await db.get('SELECT * FROM usuarios WHERE telefono = ? OR merchant_id = ?', [telefono, telefono]);
        if (!usuario) {
            return res.status(404).json({ success: false, message: '❌ Usuario no encontrado en el sistema.' });
        }

        // Soporta cambio de PIN usando el PIN actual de 4 dígitos o el temporal de 6 dígitos
        let pinActualValido = false;
        if (pinActual.length === 6) {
            const registroOTP = codigosRecuperacion.get(usuario.telefono);
            if (registroOTP && registroOTP.otp === pinActual && (Date.now() - registroOTP.timestamp <= 5 * 60 * 1000)) {
                pinActualValido = true;
                codigosRecuperacion.delete(usuario.telefono);
            }
        }
        if (!pinActualValido && usuario.pinSeguridad && usuario.pinSeguridad === pinActual) {
            pinActualValido = true;
        }

        if (!pinActualValido) {
            return res.status(401).json({ success: false, message: '❌ El PIN actual ingresado es incorrecto.' });
        }

        await db.run('UPDATE usuarios SET pinSeguridad = ? WHERE id = ?', [pinNuevo, usuario.id]);

        await enviarMensajeWhatsappSeguro(
            usuario.telefono,
            `🔐 *SEGURIDAD ACTUALIZADA*\n\nTu PIN de seguridad de 4 dígitos ha sido modificado con éxito.\nSi no fuiste tú, comunícate de inmediato con soporte.`
        );

        res.json({ success: true, message: '¡PIN cambiado con éxito!' });
    } catch (err) {
        return res.status(500).json({ success: false, message: '❌ Error interno al actualizar el PIN.' });
    }
});

// ==========================================
// RUTA DE REGISTRO DE MÉTODOS / MONEDEROS DE RECEPCIÓN (VERIFICACIÓN ÚNICA CERO TERCEROS)
// ==========================================
app.post('/api/registrar-metodos', limiterRegistroBot, async (req, res) => {
    const { cedulaTitular: cedRaw, metodo: metRaw, cuentaDestino: destRaw } = req.body || {};
    const cedCheck = String(cedRaw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const destCheck = String(destRaw || '').trim().toLowerCase();
    const cedulasBloqueadas = new Set(['V12345678', '12345678', 'V99999999', '99999999', 'V11111111', '11111111', 'V99000001', 'V99000002', 'V99000003']);
    if (cedulasBloqueadas.has(cedCheck) || /^0x0{20,}/.test(destCheck)) {
        return res.status(400).json({ success: false, message: 'Registro bloqueado por datos inválidos o de prueba.' });
    }
    const { cedulaTitular, metodo, cuentaDestino, telefono } = req.body;

    if (!cedulaTitular || !metodo || !cuentaDestino) {
        return res.status(400).json({ success: false, message: 'Faltan datos obligatorios para vincular tu monedero o cuenta de recepción.' });
    }

    const cedulaLimpia = cedulaTitular.trim();
    const regexCedula = /^[VEJGvejg]?[-]?\d{6,10}$/;
    if (!regexCedula.test(cedulaLimpia)) {
        return res.status(400).json({ 
            success: false, 
            message: '❌ Cédula inválida. Ingrese un documento de identidad real (Ej: V12345678 o 12345678).' 
        });
    }

    const destinoLimpio = cuentaDestino.trim().toLowerCase();
    const metodoElegido = metodo.trim().toLowerCase();
    let esValido = false;
    let mensajeErrorFormato = '';
    let correoExtraido = null;
    const metodosSoportados = ['binance', 'airtm', 'bybit', 'okx', 'trc20', 'bep20', 'polygon'];
   
    if (!metodosSoportados.includes(metodoElegido)) {
        return res.status(400).json({ success: false, message: '❌ El método de pago, exchange o monedero seleccionado no es válido.' });
    }

    if (metodoElegido === 'binance') {
        const regexBinanceEmail = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
        const regexBinanceID = /^\d{8,12}$/;
        if (regexBinanceEmail.test(destinoLimpio)) {
            esValido = true;
            correoExtraido = destinoLimpio;
        } else if (regexBinanceID.test(destinoLimpio)) {
            esValido = true;
        } else {
            mensajeErrorFormato = '❌ Cuenta, correo o Pay ID inválido para Binance Pay.';
        }
    } else if (metodoElegido === 'bybit' || metodoElegido === 'okx') {
        const regexEx = /^([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|\d{7,12})$/;
        if (regexEx.test(destinoLimpio)) {
            esValido = true;
            if (destinoLimpio.includes('@')) correoExtraido = destinoLimpio;
        } else {
            mensajeErrorFormato = `❌ Cuenta o correo inválido para ${metodoElegido.toUpperCase()}.`;
        }
} else if (metodoElegido === 'airtm') {
    const regexCorreoGeneral = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (regexCorreoGeneral.test(destinoLimpio)) {
        esValido = true;
        correoExtraido = destinoLimpio;
    } else {
        mensajeErrorFormato = '❌ Para AirTM debe ingresar un correo electrónico válido.';
    }
} else if (['trc20', 'bep20', 'polygon'].includes(metodoElegido)) {
    if (destinoLimpio.length >= 20) {
        esValido = true;
    } else {
        mensajeErrorFormato = '❌ La dirección de monedero cripto es demasiado corta o inválida.';
    }
}

    if (!esValido) {
        return res.status(400).json({ success: false, message: mensajeErrorFormato });
    }

    const ahora = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });

    try {
        await db.run(
            'INSERT INTO metodos_pago (cedulaTitular, metodo, cuentaDestino, fechaRegistro) VALUES (?, ?, ?, ?)',
            [cedulaLimpia, metodoElegido, cuentaDestino.trim(), ahora]
        );

        if (telefono) {
            const telLimpio = String(telefono).replace(/\D/g, '');
          const conflictoCedula = await db.get(
            'SELECT id, telefono FROM usuarios WHERE cedula = ? AND telefono != ? AND telefono != ?',
            [cedulaLimpia, telefono, telLimpio]
          );
          if (conflictoCedula) {
            return res.status(409).json({
              success: false,
              message: 'Esta cédula ya se encuentra vinculada a otro número de teléfono.'
            });
          }

          let usuarioActual = await db.get(
            'SELECT * FROM usuarios WHERE telefono = ? OR telefono = ? OR merchant_id = ?',
            [telefono, telLimpio, telefono]
          );

          if (!usuarioActual) {
            await db.run(
              'INSERT INTO usuarios (telefono, cedula, correo, metodoVinculado) VALUES (?, ?, ?, 1)',
              [telLimpio, cedulaLimpia, correoExtraido || null]
            );
            usuarioActual = await db.get('SELECT * FROM usuarios WHERE telefono = ?', [telLimpio]);
          } else {
            await db.run(
              'UPDATE usuarios SET metodoVinculado = 1, cedula = COALESCE(cedula, ?), correo = COALESCE(correo, ?) WHERE id = ?',
              [cedulaLimpia, correoExtraido || null, usuarioActual.id]
            );
          }

          if (usuarioActual && usuarioActual.id) {
            const walletExiste = await db.get('SELECT id FROM wallets WHERE user_id = ?', [usuarioActual.id]);
            if (!walletExiste) {
              await db.run('INSERT INTO wallets (user_id, usdt_balance) VALUES (?, 0.00)', [usuarioActual.id]);
            }
          }

            if (correoExtraido) {
                const htmlBienvenida = `
                    <div style="font-family: Arial, sans-serif; color: #333; max-width: 650px; margin: 0 auto; padding: 25px; border: 1px solid #e0e0e0; border-radius: 10px; background-color: #ffffff;">
                      <h1 style="color: #2b6cb0; text-align: center;">¡Bienvenido a PagoMovil USDT! 🚀</h1>
                      <p>Hola,</p>
                      <p>Tu cuenta ha sido verificada y tu monedero/cuenta de recepción ha quedado vinculado exitosamente con la Cédula/ID: <strong>${cedulaLimpia}</strong>.</p>
                      
                      <div style="background-color: #e6fffa; border-left: 4px solid #319795; padding: 15px; margin: 20px 0; border-radius: 4px;">
                        <h4 style="margin-top: 0; color: #234e52;">🔒 Verificación Única y Seguridad Cero Terceros</h4>
                        <p style="margin-bottom: 0; font-size: 14px; color: #2c7a7b;">
                          Te hemos solicitado la configuración de tu cuenta o monedero de recepción por <strong>única vez</strong> como método válido de verificación de seguridad. Esto garantiza un entorno libre de terceros y 100% confiable para todos los usuarios.
                        </p>
                      </div>

                      <div style="background-color: #ebf8ff; border-left: 4px solid #3182ce; padding: 15px; margin: 20px 0; border-radius: 4px;">
                        <h3 style="margin-top: 0; color: #2b6cb0;">📖 Guía de Ayuda e Instrucciones Rápidas</h3>
                        <ul style="padding-left: 20px; margin-bottom: 0;">
                          <li><strong>Recargas en USDT (Polygon):</strong> Transfiere USDT en la red Polygon a la wallet oficial y registra el Hash (txHash) para acreditar tu saldo de inmediato.</li>
                          <li><strong>Envíos entre usuarios:</strong> Envía pagos en USDT al instante usando el número de teléfono o ID de Comercio del destinatario.</li>
                          <li><strong>Retiros:</strong> Retira tus USDT directamente a Binance, Zinli, Zelle u otros monederos configurados.</li>
                          <li><strong>Cuenta Comercial:</strong> Si tienes un negocio, solicita el cambio de plan a Comercial para obtener tu código QR de cobro automático.</li>
                        </ul>
                      </div>

                      <div style="background-color: #f7fafc; border: 1px solid #e2e8f0; padding: 15px; margin: 20px 0; border-radius: 4px; font-size: 13px; color: #4a5568;">
                        <h4 style="margin-top: 0; color: #2d3748;">📜 Términos, Condiciones y Políticas del Servicio</h4>
                        <ol style="padding-left: 18px; margin-bottom: 0;">
                          <li><strong>Verificación de Transacciones:</strong> Las recargas se auditan en la red Polygon. Hashes duplicados o inválidos serán rechazados.</li>
                          <li><strong>Comisiones:</strong> Las transferencias y retiros poseen tarifas administrativas reflejadas de manera transparente en tu panel.</li>
                          <li><strong>Seguridad:</strong> Tu PIN de 4 dígitos es estrictamente personal. Soporte nunca te pedirá esta clave.</li>
                          <li><strong>Límites:</strong> Las cuentas naturales poseen límites operativos diarios ampliables al pasar a plan Comercial.</li>
                        </ol>
                      </div>

                      <div style="text-align: center; margin-top: 25px;">
                        <p style="font-size: 12px; color: #a0aec0;">Este es un mensaje automático de confirmación de registro y políticas del sistema.</p>
                      </div>
                    </div>
                `;
                await enviarCorreoResend(correoExtraido, '¡Bienvenido a PagoMovil USDT! - Guía y Verificación Oficial', htmlBienvenida);
            }
        }

        res.json({ success: true, message: '¡Monedero/Cuenta de recepción validado con éxito! Ya estás en verde para operar.' });
    } catch (err) {
        console.error("Error guardando método de pago:", err.message);
        return res.status(500).json({ success: false, message: 'Error interno al registrar el método de pago.' });
    }
});

app.get('/api/historial/:telefono', limiterConsultasComercio, async (req, res) => {
    const busqueda = (req.params.telefono || '').trim();
    try {
        const rows = await db.all(
            `SELECT * FROM transacciones 
             WHERE telefonoEmisor = ? 
                OR telefonoDestino = ? 
                OR telefonoEmisor IN (SELECT merchant_id FROM usuarios WHERE telefono = ?)
                OR telefonoDestino IN (SELECT merchant_id FROM usuarios WHERE telefono = ?)
                OR (telefonoEmisor = 'EXTERNO_EXCHANGE' AND telefonoDestino = ?) 
             ORDER BY id DESC LIMIT 10`,
            [busqueda, busqueda, busqueda, busqueda, busqueda]
        );
        res.json({ 
            success: true, 
            transacciones: rows, 
            historial: rows,
            avisoAutolimpieza: "Mostrando las últimas 10 operaciones."
        });
    } catch (err) {
        console.error("Error consultando historial:", err.message);
        return res.status(500).json({ success: false, message: 'Error al consultar historial en la base de datos' });
    }
});
// ==========================================
// RUTA PARA OBTENER LA WALLET PERSONAL DEL USUARIO
// ==========================================
app.get('/api/usuario-wallet/:telefono', async (req, res) => {
    const telefono = (req.params.telefono || '').trim();
    try {
        const user = await db.get('SELECT assigned_wallet FROM usuarios WHERE telefono = ? OR merchant_id = ?', [telefono, telefono]);
        if (!user || !user.assigned_wallet) {
            // Si por alguna razón no la tuviera creada, se la generamos de emergencia
            const nueva = generarWalletIndividual();
            await db.run('UPDATE usuarios SET assigned_wallet = ?, private_key = NULL WHERE telefono = ? OR merchant_id = ?', [nueva.address, telefono, telefono]);
            return res.json({ success: true, wallet: nueva.address });
        }
        res.json({ success: true, wallet: user.assigned_wallet });
    } catch (err) {
        console.error("Error obteniendo wallet personal:", err.message);
        res.status(500).json({ success: false, message: 'Error interno al obtener la wallet' });
    }
});
// ==========================================
// RUTA DE ENVÍO DE CÓDIGO POR WHATSAPP
// ==========================================
app.post('/api/enviar-codigo', limiterPagos, async (req, res) => {
    let telefono = (req.body.telefono || '').trim();
    const pinSeguridad = (req.body.pinSeguridad || '').trim();
    
    if (!telefono || !pinSeguridad) {
        return res.status(400).json({ success: false, message: 'El teléfono y el PIN de seguridad son obligatorios.' });
    }

    const telefonoLimpio = telefono.replace(/\D/g, '');
    const regexMovilVenezuela = /^0?(412|414|424|416|426)\d{7}$/;
    
    if (!regexMovilVenezuela.test(telefonoLimpio)) {
        return res.status(400).json({ 
            success: false, 
            message: '❌ Prefijo o número móvil inválido. En Venezuela solo se permiten operadoras oficiales.' 
        });
    }

    try {
        const usuarioExistente = await db.get('SELECT * FROM usuarios WHERE telefono = ? OR merchant_id = ?', [telefono, telefono]);
        const codigoVerificacion = Math.floor(100000 + Math.random() * 900000).toString();

        if (usuarioExistente) {
            let pinValido = false;
            if (pinSeguridad.length === 6) {
                const registroOTP = codigosRecuperacion.get(usuarioExistente.telefono);
                if (registroOTP && registroOTP.otp === pinSeguridad && (Date.now() - registroOTP.timestamp <= 5 * 60 * 1000)) {
                    pinValido = true;
                    codigosRecuperacion.delete(usuarioExistente.telefono);
                }
            }
            if (!pinValido && !usuarioExistente.pinSeguridad && /^\d{4}$/.test(pinSeguridad)) {
          await db.run('UPDATE usuarios SET pinSeguridad = ? WHERE id = ?', [pinSeguridad, usuarioExistente.id]);
          usuarioExistente.pinSeguridad = pinSeguridad;
          pinValido = true;
        }

        if (!pinValido && usuarioExistente.pinSeguridad && usuarioExistente.pinSeguridad === pinSeguridad) {
                pinValido = true;
            }
if (!pinValido) {
                return res.status(401).json({ 
                    success: false, 
                    message: '❌ Acceso denegado. Este número ya está registrado y el PIN de seguridad es incorrecto.' 
                });
            }

            const esComercio = usuarioExistente.accountType === 'comercial' || usuarioExistente.accountType === 'emprendedor';
            if (!esComercio && usuarioExistente.metodoVinculado !== 1) {
                return res.status(403).json({
                    success: false,
                    bloqueoRegistro: true,
                    message: '❌ Acceso restringido. Debe vincular obligatoriamente su Cédula y Monedero/Cuenta de recepción para operar.',
                    telefono: usuarioExistente.telefono
                });
            }

            const mensajeLogin = `¡Acceso Verificado en PagoMóvilUSDT! 🟢\n\nTu línea ha sido autenticada correctamente.\n\n🔢 *Código de verificación:* *${codigoVerificacion}*`;
            await enviarMensajeWhatsappSeguro(telefono, mensajeLogin);

            return res.json({ 
                success: true, 
                message: '¡Acceso autorizado y código enviado por WhatsApp con éxito!'
            });
        } else {
            return res.status(404).json({ success: false, message: '❌ El número no está registrado. Debe registrarse primero.' });
        }
    } catch (err) {
        return res.status(500).json({ success: false, message: '❌ Error interno al procesar la solicitud.' });
    }
});

      
// ==========================================
// CAMBIO A CUENTA COMERCIAL
// ==========================================
const procesarUpgradeComercialHandler = async (req, res) => {
    const telefono = (req.body.telefono || req.body.telefonoUsuario || '').trim();
    const pinSeguridad = (req.body.pinSeguridad || '').trim();
    const planDeseado = req.body.planDeseado || 'comercial';

    if (!telefono) {
        return res.status(400).json({ 
            success: false, 
            message: 'El número de teléfono es obligatorio para solicitar el cambio de plan.' 
        });
    }

    try {
        const usuario = await db.get('SELECT * FROM usuarios WHERE telefono = ? OR merchant_id = ?', [telefono, telefono]);
        if (!usuario) {
            return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
        }

        if (pinSeguridad && usuario.pinSeguridad && usuario.pinSeguridad !== pinSeguridad) {
            return res.status(401).json({ success: false, message: '❌ PIN de seguridad incorrecto.' });
        }

        if (usuario.accountType === 'comercial' || usuario.accountType === 'emprendedor') {
            return res.json({
                success: true,
                message: `Tu cuenta ya es Comercial. Tu ID QR es ${usuario.merchant_id}.`,
                merchantId: usuario.merchant_id,
                accountType: usuario.accountType
            });
        }

        const wallet = await db.get('SELECT * FROM wallets WHERE user_id = ?', [usuario.id]);
        if (!wallet || wallet.usdt_balance < COSTO_CAMBIO_PLAN_COMERCIAL) {
            return res.status(400).json({ 
                success: false, 
                message: `❌ Saldo insuficiente. Requieres al menos $${COSTO_CAMBIO_PLAN_COMERCIAL} USDT en tu billetera.` 
            });
        }

        const nuevoSaldo = wallet.usdt_balance - COSTO_CAMBIO_PLAN_COMERCIAL;
        const limiteIlimitado = 999999.00;
        const ahora = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });
        const refComision = 'UPG-' + Math.floor(100000 + Math.random() * 900000);

        const randomSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
        const merchantAliasUnico = `MERCHANT-${randomSuffix}`;

        await db.run('UPDATE wallets SET usdt_balance = ? WHERE id = ?', [nuevoSaldo, wallet.id]);
        await db.run(
            'INSERT INTO comisiones (tipo, monto, referencia, fechaHora) VALUES (?, ?, ?, ?)',
            ['binance', COSTO_CAMBIO_PLAN_COMERCIAL, refComision, ahora]
        );
        await db.run(
            `UPDATE usuarios SET merchant_id = ?, accountType = ?, dailyLimit = ?, upgradedAt = ? WHERE id = ?`,
            [merchantAliasUnico, planDeseado, limiteIlimitado, ahora, usuario.id]
        );

        await enviarMensajeWhatsappSeguro(
            usuario.telefono,
            `¡ACTIVACIÓN COMERCIAL EXITOSA! 🚀\n\nID: ${merchantAliasUnico}\nComisión: $${COSTO_CAMBIO_PLAN_COMERCIAL} USDT`
        );

        res.json({
            success: true,
            message: `¡Cuenta actualizada a comercial! Tu ID QR único generado es ${merchantAliasUnico}.`,
            merchantId: merchantAliasUnico,
            nuevoSaldo: nuevoSaldo.toFixed(2),
            accountType: planDeseado,
            dailyLimit: limiteIlimitado
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: 'Error interno procesando el cambio de cuenta.' });
    }
};

app.post('/api/solicitar-comercial', limiterPagos, procesarUpgradeComercialHandler);
app.post('/api/upgrade-comercial', limiterPagos, procesarUpgradeComercialHandler);

app.post('/api/upgrade-account', limiterPagos, async (req, res) => {
    const telefono = (req.body.telefono || '').trim();
    const accountType = req.body.accountType;
    if (!telefono || !accountType) {
        return res.status(400).json({ success: false, message: 'Faltan datos requeridos.' });
    }
    const nuevoLimite = 999999.00;
    const ahora = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });

    try {
        const resultado = await db.run(
            `UPDATE usuarios SET accountType = ?, dailyLimit = ?, upgradedAt = ? WHERE telefono = ? OR merchant_id = ?`,
            [accountType, nuevoLimite, ahora, telefono, telefono]
        );
        if (resultado.changes === 0) return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
        
        res.json({ success: true, message: `¡Cuenta actualizada a ${accountType.toUpperCase()}!` });
    } catch (err) {
        return res.status(500).json({ success: false, message: 'Error en base de datos.' });
    }
});

// ==========================================
// PROCESAR RETIRO DESDE LA WALLET INDIVIDUAL
// ==========================================
async function procesarRetiroHandler(req, res) {
    try {
        const { telefono, pin, direccionDestino, monto } = req.body;

        // 1. Validar que vengan los datos obligatorios
        if (!telefono || !direccionDestino || !monto) {
            return res.status(400).json({ success: false, message: 'Faltan datos obligatorios para el retiro (dirección o monto).' });
        }

        // 2. Buscar al usuario y su PIN en SQLite
        const usuario = await db.get('SELECT * FROM usuarios WHERE telefono = ?', [telefono]);
        if (!usuario) {
            return res.status(400).json({ success: false, message: 'Usuario no encontrado en la plataforma.' });
        }

        if (pin && usuario.pinSeguridad && usuario.pinSeguridad !== pin) {
            return res.status(400).json({ success: false, message: 'PIN incorrecto.' });
        }

        // 3. Verificar saldo en el monedero del usuario
        const walletUser = await db.get('SELECT * FROM wallets WHERE user_id = ?', [usuario.id]);
        if (!walletUser) {
            return res.status(400).json({ success: false, message: 'Monedero no encontrado para este usuario.' });
        }

        const montoNum = parseFloat(monto);
        const COMISION = 1.0; // 1 USDT de comisión
        const montoNeto = montoNum - COMISION;
        if (montoNeto <= 0) {
            return res.status(400).json({ success: false, message: 'El monto del retiro debe ser superior a la comisión ($1.00).' });
        }

        if (walletUser.usdt_balance < montoNum) {
            return res.status(400).json({ success: false, message: 'Saldo insuficiente en tu monedero.' });
        }

        // 4. Descontar saldo localmente en la base de datos
        await db.run('UPDATE wallets SET usdt_balance = usdt_balance - ? WHERE user_id = ?', [montoNum, usuario.id]);

        const referenciaRetiro = 'RET-' + Math.floor(100000 + Math.random() * 900000);
      const hashRetiro = '0xRET' + require("crypto").createHash("sha256").update(`${referenciaRetiro}|${usuario.telefono}|${direccionDestino}|${montoNum}|${Date.now()}`).digest("hex").slice(0, 40);
      const fechaHoraRetiro = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });
      const saldoAnteriorRetiro = Number(walletUser.usdt_balance || 0);
      const saldoRestanteRetiro = Math.max(0, saldoAnteriorRetiro - montoNum);

      await db.run(
        'INSERT INTO transacciones (referencia, monto, telefonoEmisor, telefonoDestino, reference_hash, fechaHora) VALUES (?, ?, ?, ?, ?, ?)',
        [referenciaRetiro, montoNum, usuario.telefono, direccionDestino.trim(), hashRetiro, fechaHoraRetiro]
      );

      // 5. Retornar éxito con detalle completo para comprobante y verificación
    await notificarRespaldoPendienteSiAplica(req.body && (req.body.userId || req.body.user_id) || (usuario && usuario.id));
      return res.json({
        success: true,
        message: `Retiro de $${montoNeto.toFixed(2)} USDT procesado con éxito!`,
        referencia: referenciaRetiro,
        hashRetiro: hashRetiro,
        txHash: hashRetiro,
        montoSolicitado: Number(montoNum.toFixed(2)),
        comision: Number(COMISION.toFixed(2)),
        montoNeto: Number(montoNeto.toFixed(2)),
        saldoRetirado: Number(montoNum.toFixed(2)),
        saldoAnterior: Number(saldoAnteriorRetiro.toFixed(2)),
        saldoRestante: Number(saldoRestanteRetiro.toFixed(2)),
        direccionDestino: direccionDestino.trim(),
        fechaHora: fechaHoraRetiro
      });

    } catch (error) {
        console.error("Error en procesarRetiroHandler:", error);
        return res.status(500).json({ success: false, message: `Error en el servidor al procesar el retiro: ${error.message}` });
    }
}
// ==========================================
// PROCESAMIENTO DE ENVÍOS DE PAGO ENTRE USUARIOS
// ==========================================
const enviarPagoHandler = async (req, res) => {
    try {
        const { telefonoEmisor, pinSeguridad, telefonoDestino, telefonoComercio, monto } = req.body;
    const destinoFinal = (telefonoDestino || telefonoComercio || "").trim();

        if (!telefonoEmisor || !pinSeguridad || !destinoFinal || !monto) {
            return res.status(400).json({ success: false, message: 'Faltan datos obligatorios para el envío.' });
        }

        const montoNum = parseFloat(monto);
        if (isNaN(montoNum) || montoNum <= 0) {
            return res.status(400).json({ success: false, message: 'Monto de pago inválido.' });
        }

        // 1. Validar emisor y PIN
        const emisor = await db.get('SELECT * FROM usuarios WHERE telefono = ? OR merchant_id = ?', [telefonoEmisor, telefonoEmisor]);
        if (!emisor || emisor.pinSeguridad !== pinSeguridad) {
            return res.status(400).json({ success: false, message: 'PIN incorrecto o emisor no encontrado.' });
        }

        // 2. Validar saldo del emisor en la tabla wallets
        const walletEmisor = await db.get('SELECT * FROM wallets WHERE user_id = ?', [emisor.id]);
        if (!walletEmisor || walletEmisor.usdt_balance < montoNum) {
            return res.status(400).json({ success: false, message: 'Saldo insuficiente en tu monedero para realizar el envío.' });
        }

        // 3. Validar destinatario (puede ser teléfono o merchant_id)
        const receptor = await db.get('SELECT * FROM usuarios WHERE telefono = ? OR merchant_id = ?', [destinoFinal, destinoFinal]);
        if (!receptor) {
            return res.status(400).json({ success: false, message: 'El usuario destinatario no existe en la plataforma.' });
        }

        if (emisor.id === receptor.id) {
            return res.status(400).json({ success: false, message: 'No puedes hacerte un envío a ti mismo.' });
        }

        let walletReceptor = await db.get('SELECT * FROM wallets WHERE user_id = ?', [receptor.id]);
        if (!walletReceptor) {
            const nuevaW = await db.run('INSERT INTO wallets (user_id, usdt_balance) VALUES (?, 0.00)', [receptor.id]);
            walletReceptor = { id: nuevaW.lastID, usdt_balance: 0.00 };
        }

        // 4. Ejecutar transferencia de saldos localmente de forma atómica
        await db.run('UPDATE wallets SET usdt_balance = usdt_balance - ? WHERE user_id = ?', [montoNum, emisor.id]);
        await db.run('UPDATE wallets SET usdt_balance = usdt_balance + ? WHERE user_id = ?', [montoNum, receptor.id]);

        const referenciaPago = 'PAY-' + Math.floor(100000 + Math.random() * 900000);
        const ahora = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });

        // Registrar transacción
        await db.run(
            'INSERT INTO transacciones (referencia, monto, telefonoEmisor, telefonoDestino, fechaHora) VALUES (?, ?, ?, ?, ?)',
            [referenciaPago, montoNum, emisor.telefono, receptor.telefono, ahora]
        );

        // Notificar por WhatsApp opcionalmente si está disponible
        await enviarMensajeWhatsappSeguro(
          receptor.telefono,
          `🟢 *PAGO RECIBIDO*\n\nMonto: ${montoNum.toFixed(2)} USDT\nDe: ${emisor.telefono}\nRef: ${referenciaPago}`
        );
        await enviarMensajeWhatsappSeguro(
          emisor.telefono,
          `🔴 *PAGO ENVIADO*\n\nMonto: ${montoNum.toFixed(2)} USDT\nPara: ${receptor.telefono}\nRef: ${referenciaPago}`
        );

    await notificarRespaldoPendienteSiAplica(req.body && (req.body.userId || req.body.user_id) || (usuario && usuario.id));
        return res.json({
            success: true,
            message: `¡Pago de $${montoNum.toFixed(2)} USDT enviado con éxito!`,
            referencia: referenciaPago
        });

    } catch (err) {
        console.error("Error procesando envío de pago:", err);
        return res.status(500).json({ success: false, message: 'Error interno procesando el pago: ' + err.message });
    }
};


// ==========================================
// RECARGA DIRECTA A LA WALLET PERSONAL (SIN HASHES)
// ==========================================
const logicaRecargaHandler = async (req, res) => {
    let phoneNumber = (req.body.phoneNumber || req.body.telefono || req.body.phone || '').trim();
    let amount = req.body.amount || req.body.monto || req.body.cantidad || req.body.valor;

    const procesarConTelefono = async (telObjetivo) => {
        const montoLimpio = parseFloat(amount);

        if (!amount) {
            return res.status(400).json({ success: false, message: 'El monto de recarga es obligatorio.' });
        }

        if (isNaN(montoLimpio) || montoLimpio < MONTO_MINIMO_RECARGA) {
            return res.status(400).json({ success: false, message: `Monto mínimo de recarga: $${MONTO_MINIMO_RECARGA.toFixed(2)} USDT.` });
        }

        try {
            const comisionAplicar = calcularComisionRecarga(montoLimpio);
            const montoNetoAcreditar = montoLimpio - comisionAplicar;

            let wallet = await db.get(`
                SELECT wallets.id, wallets.usdt_balance, usuarios.telefono 
                FROM usuarios 
                LEFT JOIN wallets ON wallets.user_id = usuarios.id 
                WHERE usuarios.telefono = ? OR usuarios.merchant_id = ?
            `, [telObjetivo, telObjetivo]);

            let walletId;
            let saldoActual = 0.00;
            let telReal = telObjetivo;

            if (wallet && wallet.id) {
                walletId = wallet.id;
                saldoActual = wallet.usdt_balance;
                telReal = wallet.telefono;
            } else {
                const user = await db.get('SELECT id, telefono FROM usuarios WHERE telefono = ? OR merchant_id = ?', [telObjetivo, telObjetivo]);
                if (!user) return res.status(400).json({ success: false, error: `Destinatario no registrado.` });
                const newW = await db.run('INSERT INTO wallets (user_id, usdt_balance) VALUES (?, 0.00)', [user.id]);
                walletId = newW.lastID;
                telReal = user.telefono;
            }

                const userWalletInfo = await db.get('SELECT id, telefono, assigned_wallet FROM usuarios WHERE telefono = ? OR merchant_id = ? LIMIT 1', [telObjetivo, telObjetivo]);
if (!userWalletInfo || !userWalletInfo.assigned_wallet) {
  return res.status(400).json({ success: false, message: '❌ No tienes una cartera Polygon asignada para verificar depósitos reales.' });
}
const checkPolygon = await consultarSaldoUsdtPolygon(userWalletInfo.assigned_wallet);
if (!checkPolygon.ok) {
  return res.status(400).json({ success: false, message: `❌ ${checkPolygon.mensaje}` });
}
if (checkPolygon.saldo < montoLimpio) {
  return res.status(400).json({ success: false, message: `❌ Saldo insuficiente en tu cartera Polygon (${checkPolygon.saldo.toFixed(2)} USDT disponibles; necesitas al menos ${montoLimpio.toFixed(2)} USDT).`, saldoPolygon: checkPolygon.saldo });
}
const refPolygon = `POLY-${userWalletInfo.assigned_wallet.slice(-6).toUpperCase()}-${Date.now().toString().slice(-6)}`;

    const nuevoSaldo = saldoActual + montoNetoAcreditar;
// dup_removed: const refPolygon = 'REC-' + Math.floor(100000 + Math.random() * 900000);
            const ahora = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });

            // Actualizar balance y registrar la transacción sin depender de hashes
            await db.run('UPDATE wallets SET usdt_balance = ? WHERE id = ?', [nuevoSaldo, walletId]);
            await db.run(`
                INSERT INTO transacciones (referencia, monto, telefonoEmisor, destinoFinal, reference_hash, fechaHora) 
                VALUES (?, ?, ?, ?, ?, ?)
            `, [refPolygon, montoLimpio, userWalletInfo.assigned_wallet, telReal, refPolygon, ahora]);
            
            await db.run(
                'INSERT INTO comisiones (tipo, monto, referencia, fechaHora) VALUES (?, ?, ?, ?)',
                ['binance', comisionAplicar, refPolygon, ahora]
            );

            await enviarMensajeWhatsappSeguro(telReal, `¡RECARGA ACREDITADA CON ÉXITO! 📥\nMonto: $${montoLimpio.toFixed(2)}\nAcreditado: $${montoNetoAcreditar.toFixed(2)}\nRef: ${refPolygon}`);

            res.json({ 
                success: true, 
                message: `¡Recarga de $${montoLimpio.toFixed(2)} USDT procesada! Acreditados $${montoNetoAcreditar.toFixed(2)}. Ref: ${refPolygon}`,
                montoAcreditado: montoNetoAcreditar.toFixed(2),
                comisionAplicada: comisionAplicar.toFixed(2),
                referencia: refPolygon
            });
        } catch (err) {
            console.error("Error en recarga directa:", err.message);
            return res.status(500).json({ success: false, error: "Error procesando recarga en la base de datos" });
        }
    };

    if (!phoneNumber) {
        const rowUser = await db.get('SELECT telefono FROM usuarios ORDER BY id DESC LIMIT 1');
        if (rowUser && rowUser.telefono) await procesarConTelefono(rowUser.telefono);
        else return res.status(400).json({ success: false, message: 'No hay usuarios registrados.' });
    } else {
        await procesarConTelefono(phoneNumber);
    }
};

app.post('/api/enviar-pago', limiterPagos, enviarPagoHandler);
app.post('/procesar-pago', limiterPagos, enviarPagoHandler);
app.post('/api/procesar-retiro', limiterPagos, procesarRetiroHandler);
app.post('/api/recargar', limiterPagos, logicaRecargaHandler);
app.post('/recargar', limiterPagos, logicaRecargaHandler);

// ==========================================
// MANTENIMIENTO AUTOMÁTICO
// ==========================================
setInterval(async () => {
    try {
        if (db) {
            await db.run("DELETE FROM transacciones WHERE fechaHora < datetime('now', '-60 days')");
            await db.run("VACUUM;");
        }
    } catch (e) {}
}, 24 * 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;

app.post("/api/bot-recuperacion/validar-y-reactivar", limiterPagos, async (req,res)=>{ try{ const correoIngresado=String(req.body.correo||"").trim().toLowerCase(); const cedulaIngresada=String(req.body.cedula||"").trim(); const pinAnterior=String(req.body.pinAnterior||"").trim(); const nuevoTelefonoLimpio=req.body.nuevoTelefono?String(req.body.nuevoTelefono).replace(/\D/g,""):""; const nuevoPinLimpio=req.body.nuevoPin?String(req.body.nuevoPin).trim():""; if(!correoIngresado||!cedulaIngresada||!pinAnterior) return res.status(400).json({success:false,message:"Faltan datos"}); if(nuevoPinLimpio&&!/^\d{4}$/.test(nuevoPinLimpio)) return res.status(400).json({success:false,message:"PIN de 4 dígitos"}); const usuario=await db.get("SELECT * FROM usuarios WHERE cedula=? AND lower(trim(correo))=?",[cedulaIngresada,correoIngresado]); if(!usuario) return res.status(404).json({success:false,message:"No coincide cédula y correo"}); const histMatch=await db.get("SELECT id FROM pin_historial WHERE user_id=? AND pin_valor=? LIMIT 1",[usuario.id,pinAnterior]); const pinValido=(usuario.pinSeguridad&&String(usuario.pinSeguridad).trim()===pinAnterior)||Boolean(histMatch); if(!pinValido) return res.status(401).json({success:false,message:"PIN anterior no coincide"}); const pinActivacion=nuevoPinLimpio||String(Math.floor(100000+Math.random()*900000)); await db.run("UPDATE usuarios SET pinSeguridad=? WHERE id=?",[pinActivacion,usuario.id]); await db.run("INSERT INTO pin_historial (user_id,pin_valor,creado_en) VALUES (?,?,datetime('now'))",[usuario.id,pinActivacion]); let telefonoFinal=usuario.telefono; if(nuevoTelefonoLimpio&&nuevoTelefonoLimpio!==usuario.telefono){ const conf=await db.get("SELECT id FROM usuarios WHERE telefono=? AND id!=?",[nuevoTelefonoLimpio,usuario.id]); if(conf) return res.status(409).json({success:false,message:"Teléfono en uso"}); await db.run("UPDATE usuarios SET telefono=? WHERE id=?",[nuevoTelefonoLimpio,usuario.id]); telefonoFinal=nuevoTelefonoLimpio; } const w=await db.get("SELECT assigned_wallet,usdt_balance FROM wallets w LEFT JOIN usuarios u ON u.id=w.user_id WHERE w.user_id=?",[usuario.id]); if(typeof enviarCorreoResend==="function"){ await enviarCorreoResend(correoIngresado,"Reactivación Autorizada - PagoMóvil USDT","<p>Acceso reactivado. Código: <b>"+pinActivacion+"</b>. Cartera y saldo intactos.</p>"); } return res.json({success:true,reactivado:true,userId:usuario.id,telefono:telefonoFinal,assigned_wallet:(w&&w.assigned_wallet)||usuario.assigned_wallet||null,usdt_balance:w?w.usdt_balance:0}); }catch(e){ console.error(e); return res.status(500).json({success:false,message:"Error interno"}); } });


const backupReminderSentAt = new Map();

async function notificarRespaldoPendienteSiAplica(userId) {
  try {
    if (!userId) return;
    const row = await db.get(
      "SELECT u.id, u.telefono, u.respaldo_completado, COALESCE(w.usdt_balance, 0) AS usdt_balance FROM usuarios u LEFT JOIN wallets w ON w.user_id = u.id WHERE u.id = ? LIMIT 1",
      [userId]
    );
    if (!row || !row.telefono) return;
    if (Number(row.respaldo_completado || 0) === 1) return;
    if (Number(row.usdt_balance || 0) <= 0) return;

    const key = String(row.id);
    const lastSent = backupReminderSentAt.get(key) || 0;
    const oneDayMs = 24 * 60 * 60 * 1000;
    if (Date.now() - lastSent < oneDayMs) return;

    backupReminderSentAt.set(key, Date.now());
    const msg =
      "Gracias por formar parte de nuestra plataforma. Te agradecemos que descargues tu frase de 12 palabras y la guardes en un lugar seguro, ya que no podemos ayudarte a recuperarla en vista de que usted es el único dueño de su dinero.";

    if (typeof enviarMensajeWhatsappSeguro === "function") {
      await Promise.resolve(enviarMensajeWhatsappSeguro(row.telefono, msg)).catch(() => {});
    }
  } catch (e) {
    console.error("Error en notificarRespaldoPendienteSiAplica:", e);
  }
}

// === WALLET_BACKUP_OTP_ENDPOINTS ===
const crypto = require("crypto");
const walletBackupOtps = new Map();
const adminWhatsappDestino = String(process.env.ADMIN_WHATSAPP || process.env.ADMIN_PHONE || "").trim();

function normCedula(v) {
  return String(v || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function normCorreo(v) {
  return String(v || "").trim().toLowerCase();
}

app.post("/api/wallet-backup/request-code", async (req, res) => {
  try {
    const cedulaInput = normCedula(req.body && req.body.cedula);
    const correoInput = normCorreo(req.body && req.body.correo);
    const telefonoSession = String((req.body && req.body.telefono) || (req.session && req.session.telefono) || "").trim();

    if (!cedulaInput || !correoInput) {
      return res.status(400).json({ success: false, message: "Debes ingresar tu cédula y tu correo registrado." });
    }

    const sql = telefonoSession
      ? "SELECT id, telefono, cedula, correo, assigned_wallet, respaldo_completado FROM usuarios WHERE telefono = ? LIMIT 1"
      : "SELECT id, telefono, cedula, correo, assigned_wallet, respaldo_completado FROM usuarios WHERE UPPER(REPLACE(REPLACE(TRIM(cedula), '-', ''), ' ', '')) = ? AND LOWER(TRIM(correo)) = ? LIMIT 1";
    const params = telefonoSession ? [telefonoSession] : [cedulaInput, correoInput];

    const user = await db.get(sql, params);
    if (!user) {
      return res.status(404).json({ success: false, message: "No se encontró la cuenta registrada." });
    }

    if (normCedula(user.cedula) !== cedulaInput || normCorreo(user.correo) !== correoInput) {
      return res.status(403).json({ success: false, message: "La cédula o el correo no coinciden con la cuenta." });
    }

    const code = String(crypto.randomInt(100000, 999999));
    const key = String(user.id || user.telefono);
    walletBackupOtps.set(key, { code, expiresAt: Date.now() + 5 * 60 * 1000, attempts: 0 });

    const texto = "Código de 6 dígitos para respaldar tu frase de 12 palabras: " + code + " (vence en 5 min).";
    if (typeof enviarMensajeWhatsappSeguro === "function" && user.telefono) {
      await Promise.resolve(enviarMensajeWhatsappSeguro(user.telefono, texto)).catch(() => {});
    }

    return res.json({
      success: true,
      message: "Código de 6 dígitos enviado a tu WhatsApp registrado.",
      assignedWallet: user.assigned_wallet || "",
      respaldoCompletado: Boolean(user.respaldo_completado)
    });
  } catch (e) {
    console.error("Error en /api/wallet-backup/request-code:", e);
    return res.status(500).json({ success: false, message: "Error al solicitar el código." });
  }
});

app.post("/api/wallet-backup/verify-code", async (req, res) => {
  try {
    const codeInput = String((req.body && req.body.code) || "").trim();
    const cedulaInput = normCedula(req.body && req.body.cedula);
    const correoInput = normCorreo(req.body && req.body.correo);
    const telefonoSession = String((req.body && req.body.telefono) || (req.session && req.session.telefono) || "").trim();

    if (!/^[0-9]{6}$/.test(codeInput)) {
      return res.status(400).json({ success: false, message: "Ingresa un código válido de 6 dígitos." });
    }

    const sql = telefonoSession
      ? "SELECT id, telefono, cedula, correo, assigned_wallet, respaldo_completado FROM usuarios WHERE telefono = ? LIMIT 1"
      : "SELECT id, telefono, cedula, correo, assigned_wallet, respaldo_completado FROM usuarios WHERE UPPER(REPLACE(REPLACE(TRIM(cedula), '-', ''), ' ', '')) = ? AND LOWER(TRIM(correo)) = ? LIMIT 1";
    const params = telefonoSession ? [telefonoSession] : [cedulaInput, correoInput];

    const user = await db.get(sql, params);
    if (!user) {
      return res.status(404).json({ success: false, message: "Cuenta no encontrada." });
    }

    const key = String(user.id || user.telefono);
    const entry = walletBackupOtps.get(key);
    if (!entry || Date.now() > entry.expiresAt) {
      walletBackupOtps.delete(key);
      return res.status(400).json({ success: false, message: "Código vencido o no solicitado. Pide uno nuevo." });
    }
    if (entry.attempts >= 5) {
      walletBackupOtps.delete(key);
      return res.status(429).json({ success: false, message: "Demasiados intentos. Solicita otro código." });
    }
    if (entry.code !== codeInput) {
      entry.attempts += 1;
      return res.status(400).json({ success: false, message: "Código incorrecto. Revisa tu WhatsApp." });
    }

    walletBackupOtps.delete(key);
    await db.run(
      "UPDATE usuarios SET respaldo_completado = 1, respaldo_fecha = datetime('now') WHERE id = ?",
      [user.id]
    );

    if (typeof enviarMensajeWhatsappSeguro === "function" && adminWhatsappDestino) {
      const avisoAdmin =
        "Usuario verificado y respaldado: " +
        (user.telefono || user.correo || ("ID " + user.id)) +
        (user.assigned_wallet ? (" | Cartera: " + user.assigned_wallet) : "");
      await Promise.resolve(enviarMensajeWhatsappSeguro(adminWhatsappDestino, avisoAdmin)).catch(() => {});
    }

    return res.json({
      success: true,
      assignedWallet: user.assigned_wallet || "",
      respaldoCompletado: true
    });
  } catch (e) {
    console.error("Error en /api/wallet-backup/verify-code:", e);
    return res.status(500).json({ success: false, message: "Error al validar el código." });
  }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor de PagoMóvil USDT corriendo en el puerto ${PORT}`);
});