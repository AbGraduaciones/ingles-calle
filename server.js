const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const { GoogleGenAI } = require('@google/genai');

console.log('¿Leyó la llave de Gemini?:', Boolean(process.env.GEMINI_API_KEY));

const app = express();
const PORT = process.env.PORT || 3000;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SCENARIOS = {
  manager: "Eres el manager estadounidense de un restaurante/negocio ocupado. El usuario es un empleado latino que necesita pedirte un cambio de horario, un día libre o hablar sobre su pago.",
  cliente: "Eres un cliente estadounidense algo impaciente en una tienda o restaurante. El usuario te está atendiendo y debe resolver tu queja con calma.",
  tienda: "Eres un empleado de Home Depot o AutoZone en EE. UU. El usuario busca una herramienta o pieza específica y necesita ayuda.",
  clinica: "Eres recepcionista en una clínica o farmacia en EE. UU. El usuario viene a recoger una medicina o explicar un síntoma para pedir cita.",
  telefono: "Eres un agente de servicio al cliente de un banco o aseguradora en EE. UU. El usuario llamó para resolver un cobro o problema con su cuenta."
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

// 1. Ruta principal del simulador
app.post('/api/chat', async (req, res) => {
  try {
    const { scenario = 'manager', mode = 'practica', history = [], userMessage } = req.body;

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
    res.json(data);

  } catch (error) {
    console.error('Error con Gemini en /api/chat:', error);
    res.status(500).json({ error: 'Hubo un problema al conectar con la IA.' });
  }
});

// 2. Ruta para el botón "¿Cómo lo digo?" (ES -> EN)
app.post('/api/how-to-say', async (req, res) => {
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

// 3. Ruta para "Descifra al Nativo"
app.post('/api/decipher', async (req, res) => {
  try {
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
    res.json(data);

  } catch (error) {
    console.error('Error en /api/decipher:', error);
    res.status(500).json({ error: 'No se pudo generar el reto.' });
  }
});

// 4. Ruta para el diccionario rápido (EN -> ES)
app.post('/api/translate-word', async (req, res) => {
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