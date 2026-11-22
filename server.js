import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MODEL = (process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim();
const FALLBACK_MODEL = (process.env.GEMINI_FALLBACK_MODEL || '').trim();
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 35000;

if (!process.env.GEMINI_API_KEY) {
  console.warn('ATTENZIONE: GEMINI_API_KEY non impostata nel file .env');
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static('public'));

const ocrSchema = {
  type: Type.OBJECT,
  properties: {
    grid: {
      type: Type.ARRAY,
      description: 'Matrice 9x9 del Sudoku. 0 = cella vuota, 1-9 = cifra presente nella foto.',
      items: {
        type: Type.ARRAY,
        items: {
          type: Type.INTEGER
        }
      }
    }
  },
  required: ['grid']
};

const hintSchema = {
  type: Type.OBJECT,
  properties: {
    row: { type: Type.INTEGER },
    col: { type: Type.INTEGER },
    valore: { type: Type.INTEGER },
    spiegazione: { type: Type.STRING }
  },
  required: ['row', 'col', 'valore', 'spiegazione']
};

function isValidGrid9x9(grid) {
  if (!Array.isArray(grid) || grid.length !== 9) return false;
  return grid.every(
    (row) =>
      Array.isArray(row) &&
      row.length === 9 &&
      row.every((v) => Number.isInteger(v) && v >= 0 && v <= 9)
  );
}

function canPlace(board, r, c, val) {
  for (let i = 0; i < 9; i++) {
    if (board[r][i] === val || board[i][c] === val) return false;
  }
  const startRow = Math.floor(r / 3) * 3;
  const startCol = Math.floor(c / 3) * 3;
  for (let i = startRow; i < startRow + 3; i++) {
    for (let j = startCol; j < startCol + 3; j++) {
      if (board[i][j] === val) return false;
    }
  }
  return true;
}

function solveBacktracking(board) {
  const copy = board.map((row) => [...row]);

  function backtrack() {
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (copy[r][c] === 0) {
          for (let val = 1; val <= 9; val++) {
            if (canPlace(copy, r, c, val)) {
              copy[r][c] = val;
              if (backtrack()) return true;
              copy[r][c] = 0;
            }
          }
          return false;
        }
      }
    }
    return true;
  }

  return backtrack() ? copy : null;
}

function findNextMoveLocal(board) {
  const solved = solveBacktracking(board);
  if (!solved) return null;

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (board[r][c] === 0) {
        return {
          row: r,
          col: c,
          valore: solved[r][c]
        };
      }
    }
  }
  return null;
}

function getErrorStatus(err) {
  const status = Number(
    err?.status ??
      err?.statusCode ??
      err?.error?.code ??
      err?.cause?.status ??
      500
  );
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms = AI_TIMEOUT_MS) {
  let timerId;
  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      const err = new Error('Timeout chiamata AI');
      err.status = 504;
      reject(err);
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timerId);
  });
}

function isRetryable(status) {
  return status === 503 || status === 500 || status === 504;
}

function parseJsonSafe(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    const err = new Error('Risposta vuota dal modello AI');
    err.status = 502;
    throw err;
  }
  try {
    return JSON.parse(rawText);
  } catch {
    const err = new Error('Risposta non JSON valida dal modello AI');
    err.status = 502;
    throw err;
  }
}

async function generateWithRetry(requestPayload, maxRetries = 1) {
  const modelsToTry = [MODEL];
  if (FALLBACK_MODEL && FALLBACK_MODEL !== MODEL) {
    modelsToTry.push(FALLBACK_MODEL);
  }

  let lastError = null;

  for (const modelName of modelsToTry) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await withTimeout(
          ai.models.generateContent({
            ...requestPayload,
            model: modelName
          }),
          AI_TIMEOUT_MS
        );
      } catch (err) {
        lastError = err;
        const status = getErrorStatus(err);
        if (status === 404 || status === 429 || !isRetryable(status) || attempt === maxRetries) {
          break;
        }
        await sleep(1000 * (attempt + 1));
      }
    }
  }

  throw lastError || new Error('Errore sconosciuto chiamando Gemini');
}

app.post('/api/ocr', async (req, res) => {
  try {
    const { imageBase64, mimeType } = req.body || {};
    if (!imageBase64 || !mimeType) {
      return res.status(400).json({ error: 'Immagine o mimeType mancanti.' });
    }

    const prompt =
      "Analizza l'immagine del Sudoku fornita. Estrai i numeri presenti e la loro posizione. " +
      "Restituisci un oggetto JSON con il campo 'grid': un array 9x9 dove 0 rappresenta una cella " +
      "vuota e i numeri da 1 a 9 rappresentano le cifre presenti nella foto.";

    const response = await generateWithRetry({
      contents: [
        {
          inlineData: {
            data: imageBase64,
            mimeType
          }
        },
        prompt
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: ocrSchema,
        temperature: 0
      }
    });

    const data = parseJsonSafe(response.text);
    if (!isValidGrid9x9(data.grid)) {
      return res.status(422).json({ error: 'Matrice 9x9 non valida.' });
    }

    return res.json({ grid: data.grid });
  } catch (err) {
    const status = getErrorStatus(err);
    return res.status(status).json({
      error: `Errore OCR (${status}): ${err?.message || 'Errore durante analisi immagine'}`
    });
  }
});

app.post('/api/hint', async (req, res) => {
  try {
    const { grid } = req.body || {};
    if (!isValidGrid9x9(grid)) {
      return res.status(400).json({ error: 'Matrice 9x9 non valida.' });
    }

    const move = findNextMoveLocal(grid);
    if (!move) {
      return res.status(400).json({ error: 'Griglia non risolvibile o già completa.' });
    }

    const prompt =
      `Data la seguente matrice Sudoku 9x9 incompleta: ${JSON.stringify(grid)}. ` +
      'Trova LA PROSSIMA mossa più facile ed evidente da compiere. ' +
      'Restituisci un JSON con la seguente struttura: ' +
      '{ "row": int (0-8), "col": int (0-8), "valore": int (1-9), "spiegazione": "Stringa con la motivazione logica in italiano" }';

    try {
      const response = await generateWithRetry({
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: hintSchema,
          temperature: 0.2
        }
      });

      const aiData = parseJsonSafe(response.text);
      return res.json({
        row: move.row,
        col: move.col,
        valore: move.valore,
        spiegazione:
          aiData?.spiegazione ||
          `Inserisci ${move.valore} nella riga ${move.row + 1}, colonna ${move.col + 1}.`
      });
    } catch {
      return res.json({
        row: move.row,
        col: move.col,
        valore: move.valore,
        spiegazione: `Inserisci ${move.valore} in riga ${move.row + 1}, colonna ${move.col + 1} nel blocco ${
          Math.floor(move.row / 3) * 3 + Math.floor(move.col / 3) + 1
        }.`
      });
    }
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Errore suggerimento mossa.' });
  }
});

app.post('/api/solve', (req, res) => {
  const { grid } = req.body || {};
  if (!isValidGrid9x9(grid)) {
    return res.status(400).json({ error: 'Matrice 9x9 non valida.' });
  }

  const solved = solveBacktracking(grid);
  if (!solved) {
    return res.status(400).json({ error: 'Nessuna soluzione trovata per questa griglia.' });
  }

  return res.json({ solved });
});

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'JSON non valido nella richiesta.' });
  }
  return res.status(500).json({ error: err?.message || 'Errore interno del server.' });
});

app.listen(PORT, () => {
  console.log(`Server avviato su http://localhost:${PORT} con modello ${MODEL}`);
});