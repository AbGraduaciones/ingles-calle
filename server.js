const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenAI } = require('@google/genai');
const { Resend } = require('resend');

console.log('¿Leyó la llave de Gemini?:', Boolean(process.env.GEMINI_API_KEY));
console.log('¿Leyó Supabase?:', Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY));

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'clave_temporal_ingles_calle';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const FREE_SCENARIOS = ['manager', 'tienda'];
const FREE_DAILY_LIMIT = 10;

const SCENARIOS = {
  manager: "Eres el manager estadounidense de un restaurante/negocio ocupado. El usuario es un empleado latino que necesita pedirte un cambio de horario, un día libre o hablar sobre su pago.",
  cliente: "Eres un cliente estadounidense algo impaciente en una tienda o restaurante. El usuario te está atendiendo y debe resolver tu queja con calma.",
  tienda: "Eres un empleado de Home Depot o AutoZone en EE. UU. El usuario busca una herramienta o pieza específica y necesita ayuda.",
  clinica: "Eres recepcionista en una clínica o farmacia en EE. UU. El usuario viene a recoger una medicina o explicar un síntoma para pedir cita.",
  telefono: "Eres un agente de servicio al cliente de un banco o aseguradora en EE. UU. El usuario llamó para resolver un cobro o problema con su cuenta."
  restaurante: 'Eres el chef o encargado de turno en un restaurante ocupado en EE. UU. El usuario trabaja ahí (cocinero, mesero o busboy). Háblale de órdenes pendientes, mesas por limpiar, ingredientes que faltan o cambios de turno.',
limpieza: 'Eres el dueño de una casa o supervisor de limpieza en EE. UU. El usuario trabaja limpiando. Háblale sobre áreas específicas a limpiar, productos, horarios de entrada/salida o instrucciones especiales.',
ninera: 'Eres un papá o mamá ocupado en EE. UU. que contrató al usuario como niñera (babysitter/nanny). Háblale sobre horarios de comida, alergias, tareas de los niños, hora de dormir o a qué hora regresas.',
};

const MODELS_TO_TRY = [
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-3.8-flash'
];

async function callGeminiJSON(prompt, systemInstruction) {
  let lastError = null;
  for (const modelName of MODELS_TO_TRY) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: prompt,
        config: {
          systemInstruction,
          responseMimeType: 'application/json'
        }
      });
      console.log(`✅ Respondió usando: ${modelName}`);
      return JSON.parse(response.text);
    } catch (err) {
      lastError = err;
      console.log(`⚠️ ${modelName} falló (${err.status || 'error'}), probando el siguiente...`);
    }
  }
  throw lastError;
}

// Middleware de autenticación y reinicio diario de usos
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Inicia sesión para continuar.' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, plan, daily_uses, last_use_date')
      .eq('id', decoded.userId)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Sesión inválida. Inicia sesión de nuevo.' });
    }

    // Reinicia el contador si ya es un nuevo día
    const today = new Date().toISOString().split('T')[0];
    if (user.last_use_date !== today) {
      user.daily_uses = 0;
      user.last_use_date = today;
      await supabase
        .from('users')
        .update({ daily_uses: 0, last_use_date: today })
        .eq('id', user.id);
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Tu sesión expiró. Inicia sesión de nuevo.' });
  }
}

async function incrementUsage(user) {
  if (user.plan === 'pro') return user.daily_uses;
  const newUses = user.daily_uses + 1;
  const today = new Date().toISOString().split('T')[0];
  await supabase
    .from('users')
    .update({ daily_uses: newUses, last_use_date: today })
    .eq('id', user.id);
  return newUses;
}

// ==================== RUTAS DE AUTENTICACIÓN ====================

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password || password.length < 6) {
      return res.status(400).json({ error: 'Usa un correo válido y una contraseña de al menos 6 caracteres.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const password_hash = await bcrypt.hash(password, 10);

    const { data: user, error } = await supabase
      .from('users')
      .insert([{ email: cleanEmail, password_hash, plan: 'free', daily_uses: 0 }])
      .select('id, email, plan, daily_uses')
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(400).json({ error: 'Ese correo ya está registrado. Intenta iniciar sesión.' });
      }
      throw error;
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user, limit: FREE_DAILY_LIMIT });
  } catch (err) {
    console.error('Error en registro:', err);
    res.status(500).json({ error: 'No se pudo crear la cuenta.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Ingresa tu correo y contraseña.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, password_hash, plan, daily_uses, last_use_date')
      .eq('email', cleanEmail)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
      token,
      user: { id: user.id, email: user.email, plan: user.plan, daily_uses: user.daily_uses },
      limit: FREE_DAILY_LIMIT
    });
  } catch (err) {
    console.error('Error en login:', err);
    res.status(500).json({ error: 'No se pudo iniciar sesión.' });
  }
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user, limit: FREE_DAILY_LIMIT });
});
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Ingresa tu correo electrónico.' });

    const cleanEmail = email.trim().toLowerCase();
    const { data: user, error: findError } = await supabase
  .from('users')
  .select('id, email')
  .ilike('email', cleanEmail)
  .maybeSingle();

if (findError) {
  console.error('Error buscando usuario en Supabase:', findError);
  return res.status(500).json({ error: 'Error al consultar la base de datos.' });
}

    if (!user) {
      return res.status(404).json({ error: 'No encontramos una cuenta con ese correo.' });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 minutos

    await supabase
      .from('users')
      .update({ reset_code: code, reset_code_expires: expiresAt })
      .eq('id', user.id);

    if (!resend) {
      return res.status(500).json({ error: 'Falta configurar RESEND_API_KEY en el servidor.' });
    }

    const { error: mailError } = await resend.emails.send({
      from: 'Inglés Calle <onboarding@resend.dev>',
      to: cleanEmail,
      subject: `Tu código de recuperación: ${code}`,
      html: `
        <div style="font-family: sans-serif; padding: 20px;">
          <h2>Recupera tu contraseña en Inglés Calle 🇺🇸</h2>
          <p>Usa este código de 6 dígitos en la app (expira en 15 minutos):</p>
          <h1 style="letter-spacing: 6px; color: #10b981;">${code}</h1>
          <p style="font-size: 12px; color: #666;">Si no pediste este código, ignora este correo.</p>
        </div>
      `
    });

    if (mailError) {
      console.error('Error enviando correo con Resend:', mailError);
      return res.status(500).json({ error: 'No se pudo enviar el correo. Verifica tu cuenta de Resend.' });
    }

    res.json({ message: 'Te enviamos un código de 6 dígitos a tu correo.' });
  } catch (err) {
    console.error('Error en forgot-password:', err);
    res.status(500).json({ error: 'Hubo un problema al procesar tu solicitud.' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Completa todos los campos (contraseña mínimo 6 caracteres).' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const { data: user } = await supabase
      .from('users')
      .select('id, reset_code, reset_code_expires')
      .eq('email', cleanEmail)
      .single();

    if (!user || user.reset_code !== code.trim()) {
      return res.status(400).json({ error: 'El código es incorrecto.' });
    }

    if (new Date(user.reset_code_expires) < new Date()) {
      return res.status(400).json({ error: 'El código expiró. Pide uno nuevo.' });
    }

    const password_hash = await bcrypt.hash(newPassword, 10);
    await supabase
      .from('users')
      .update({ password_hash, reset_code: null, reset_code_expires: null })
      .eq('id', user.id);

    res.json({ message: '¡Contraseña actualizada! Ya puedes iniciar sesión.' });
  } catch (err) {
    console.error('Error en reset-password:', err);
    res.status(500).json({ error: 'No se pudo actualizar la contraseña.' });
  }
});
// ==================== RUTAS DE LA APP (PROTEGIDAS) ====================

// 1. Simulador principal
app.post('/api/chat', authMiddleware, async (req, res) => {
  try {
    const { scenario = 'manager', mode = 'practica', history = [], userMessage } = req.body;

    // Candado de escenarios Pro
    if (req.user.plan !== 'pro' && !FREE_SCENARIOS.includes(scenario)) {
      return res.status(403).json({
        code: 'PRO_REQUIRED',
        error: 'Este escenario es exclusivo del Plan Pro.'
      });
    }

    // Candado de límite diario
    if (req.user.plan !== 'pro' && req.user.daily_uses >= FREE_DAILY_LIMIT) {
      return res.status(403).json({
        code: 'LIMIT_REACHED',
        error: `Llegaste a tus ${FREE_DAILY_LIMIT} usos gratis de hoy. Pásate a Pro para practicar sin límites.`
      });
    }

    const scenarioDesc = SCENARIOS[scenario] || SCENARIOS.manager;
    const modeDesc = mode === 'calle'
      ? "Habla como un nativo real en la calle: usa contracciones (gonna, wanna, lemme), modismos comunes y un tono directo y natural."
      : "Habla en un inglés claro, amable y fácil de entender, con frases cortas.";

    const systemInstruction = `
      ${scenarioDesc}
      ${modeDesc}
      Reglas estrictas:
      1. Responde siempre en tu personaje en INGLÉS (máximo 2 o 3 oraciones cortas para que sea una conversación fluida).
      2. Incluye la traducción natural al ESPAÑOL de tu respuesta.
      3. Evalúa lo que dijo el usuario y dale un consejo breve en ESPAÑOL sobre cómo sonar más natural (si es el primer mensaje, solo dale la bienvenida al escenario en el consejo).
      4. Responde ÚNICAMENTE en formato JSON válido con estas tres claves exactas:
         {
           "reply": "Tu respuesta en inglés como el personaje",
           "translation": "Traducción natural al español de tu respuesta",
           "feedback": "Tu corrección o consejo corto en español"
         }
    `;

    const conversationText = history
      .map(msg => `${msg.role === 'user' ? 'Usuario' : 'Personaje'}: ${msg.text}`)
      .join('\n');

    const prompt = `${conversationText}\nUsuario: ${userMessage || 'Start the conversation in character.'}`;

    const data = await callGeminiJSON(prompt, systemInstruction);
    const updatedUses = await incrementUsage(req.user);

    res.json({
      ...data,
      usage: { plan: req.user.plan, daily_uses: updatedUses, limit: FREE_DAILY_LIMIT }
    });
  } catch (error) {
    console.error('Error con Gemini en /api/chat:', error);
    res.status(500).json({ error: 'Hubo un problema al conectar con la IA.' });
  }
});

// 2. "¿Cómo lo digo?" (ES -> EN)
app.post('/api/how-to-say', authMiddleware, async (req, res) => {
  try {
    const { spanishText, scenario = 'manager', mode = 'practica' } = req.body;
    if (!spanishText) {
      return res.status(400).json({ error: 'Escribe primero lo que quieres decir.' });
    }

    const styleDesc = mode === 'calle'
      ? "Usa inglés natural y cotidiano de EE. UU. (como realmente lo diría la gente en el trabajo o la calle)."
      : "Usa un inglés claro, educado y fácil de pronunciar.";

    const systemInstruction = `
      Eres un entrenador de inglés para latinos viviendo en Estados Unidos.
      Contexto del escenario actual: ${SCENARIOS[scenario] || SCENARIOS.manager}
      ${styleDesc}
      El usuario te dirá una idea en español y debes darle:
      1. "english": La frase exacta y natural en inglés.
      2. "pronunciation": Cómo se pronuncia escrita a lo latino (ejemplo: "I'm looking for..." -> "Aim lúkin for...").
      Responde ÚNICAMENTE en formato JSON válido con esas dos claves exactas.
    `;

    const data = await callGeminiJSON(`Quiero decir esto: "${spanishText}"`, systemInstruction);
    res.json(data);
  } catch (error) {
    console.error('Error en /api/how-to-say:', error);
    res.status(500).json({ error: 'No se pudo traducir tu frase.' });
  }
});

// 3. "Descifra al Nativo"
app.post('/api/decipher', authMiddleware, async (req, res) => {
  try {
    if (req.user.plan !== 'pro' && req.user.daily_uses >= FREE_DAILY_LIMIT) {
      return res.status(403).json({
        code: 'LIMIT_REACHED',
        error: `Llegaste a tus ${FREE_DAILY_LIMIT} usos gratis de hoy. Pásate a Pro para practicar sin límites.`
      });
    }

    const { category = 'trabajo', previousPhrases = [] } = req.body;
    const categoryMap = {
      trabajo: "Un jefe, compañero o cliente hablando rápido en el trabajo en EE. UU. (turnos, pagos, pedidos, tareas).",
      calle: "Conversación casual en la calle, vecinos, amigos o alguien preguntando algo rápido en EE. UU.",
      tiendas: "Un cajero, mesero o empleado en una tienda, restaurante o gasolinera en EE. UU."
    };

    const avoidList = previousPhrases.slice(-6).join(' | ');
    const systemInstruction = `
      Eres un creador de retos de oído para latinos en Estados Unidos llamado "Descifra al Nativo".
      Contexto: ${categoryMap[category] || categoryMap.trabajo}
      Genera UNA frase corta y muy real en inglés estadounidense que use contracciones habladas o modismos cotidianos (ej: gonna, wanna, lemme, gotta, kinda, out of, real quick, heads up, no worries, etc.).
      Evita repetir estas frases recientes: ${avoidList || 'ninguna'}.

      Responde ÚNICAMENTE en formato JSON válido con estas claves exactas:
      {
        "fastPhrase": "La frase escrita tal como suena rápido (ej: Lemme grab that real quick)",
        "cleanEnglish": "La misma frase en inglés formal/completo (ej: Let me grab that really quickly)",
        "spanishMeaning": "Qué significa realmente en español natural",
        "breakdown": "Explicación corta y clara en español de las contracciones o modismos (ej: 'Lemme' = Let me / 'real quick' = rapidito)",
        "options": ["Opción 1 en español", "Opción 2 en español", "Opción 3 en español"],
        "correctIndex": 0
      }
      Importante: Mezcla el orden de las opciones para que correctIndex sea 0, 1 o 2 de forma variada. Las otras 2 opciones deben ser traducciones creíbles pero incorrectas.
    `;

    const data = await callGeminiJSON('Genera un nuevo reto de audio real.', systemInstruction);
    const updatedUses = await incrementUsage(req.user);

    res.json({
      ...data,
      usage: { plan: req.user.plan, daily_uses: updatedUses, limit: FREE_DAILY_LIMIT }
    });
  } catch (error) {
    console.error('Error en /api/decipher:', error);
    res.status(500).json({ error: 'No se pudo generar el reto.' });
  }
});

// 4. Diccionario rápido (EN -> ES)
app.post('/api/translate-word', authMiddleware, async (req, res) => {
  try {
    const { englishText } = req.body;
    if (!englishText) {
      return res.status(400).json({ error: 'Escribe una palabra o frase en inglés.' });
    }

    const systemInstruction = `
      Eres un diccionario práctico de inglés real en Estados Unidos para latinos.
      El usuario te dará una palabra o frase en INGLÉS y debes responder ÚNICAMENTE en formato JSON válido con estas 4 claves exactas:
      {
        "spanish": "Significado principal y natural en español (si tiene uso común en la calle o el trabajo, menciónalo)",
        "pronunciation": "Cómo se pronuncia escrita a lo latino (ejemplo: 'Schedule' -> 'Ské-yul')",
        "exampleEn": "Un ejemplo corto y real en inglés usándola",
        "exampleEs": "Traducción al español de ese ejemplo"
      }
    `;

    const data = await callGeminiJSON(`Traduce y explica esto: "${englishText}"`, systemInstruction);
    res.json(data);
  } catch (error) {
    console.error('Error en /api/translate-word:', error);
    res.status(500).json({ error: 'No se pudo traducir la palabra.' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor de Ingles-Calle corriendo en http://localhost:${PORT}`);
});