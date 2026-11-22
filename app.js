const gridContainer = document.getElementById('gridContainer');
const imageInput = document.getElementById('imageInput');
const ocrBtn = document.getElementById('ocrBtn');
const hintLevel1Btn = document.getElementById('hintLevel1Btn');
const hintLevel2Btn = document.getElementById('hintLevel2Btn');
const hintLevel3Btn = document.getElementById('hintLevel3Btn');
const solveBtn = document.getElementById('solveBtn');
const clearBtn = document.getElementById('clearBtn');
const voiceToggle = document.getElementById('voiceToggle');
const feedbackBox = document.getElementById('feedbackBox');
const arCanvas = document.getElementById('arCanvas');
const arCtx = arCanvas.getContext('2d');
const avatarMouth = document.getElementById('avatarMouth');
const avatarStatus = document.getElementById('avatarStatus');

let grid = Array.from({ length: 9 }, () => Array(9).fill(0));
let initialGrid = Array.from({ length: 9 }, () => Array(9).fill(0));
let currentHint = null;
let loadedImage = null;

function setAvatarState(state, label) {
  avatarStatus.textContent = label;
  if (state === 'thinking') {
    avatarMouth.setAttribute('d', 'M 24 41 L 40 41');
  } else if (state === 'happy') {
    avatarMouth.setAttribute('d', 'M 20 37 Q 32 50 44 37');
  } else if (state === 'error') {
    avatarMouth.setAttribute('d', 'M 22 44 Q 32 35 42 44');
  } else {
    avatarMouth.setAttribute('d', 'M 22 39 Q 32 47 42 39');
  }
}

function speakText(text) {
  if (!voiceToggle.checked || !('speechSynthesis' in window) || !text) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'it-IT';
  window.speechSynthesis.speak(utterance);
}

function renderGrid(opts = {}) {
  const { highlightBlock = false, highlightCell = false, revealValue = false } = opts;
  gridContainer.innerHTML = '';

  const targetBlock = currentHint
    ? Math.floor(currentHint.row / 3) * 3 + Math.floor(currentHint.col / 3)
    : -1;

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 1;
      input.className = 'cell';
      if (c === 2 || c === 5) input.classList.add('border-right-thick');
      if (r === 2 || r === 5) input.classList.add('border-bottom-thick');

      const blockIdx = Math.floor(r / 3) * 3 + Math.floor(c / 3);
      if (highlightBlock && blockIdx === targetBlock) {
        input.classList.add('highlight-block');
      }
      if (highlightCell && currentHint && currentHint.row === r && currentHint.col === c) {
        input.classList.add('highlight-cell');
      }
      if (revealValue && currentHint && currentHint.row === r && currentHint.col === c) {
        input.classList.add('revealed-value');
      }

      input.value = grid[r][c] === 0 ? '' : String(grid[r][c]);

      input.addEventListener('input', (e) => {
        const clean = e.target.value.replace(/[^1-9]/g, '');
        const val = clean ? Number(clean) : 0;
        e.target.value = val === 0 ? '' : String(val);
        grid[r][c] = val;
        drawArOverlay();
      });

      gridContainer.appendChild(input);
    }
  }
}

function drawArOverlay() {
  arCtx.clearRect(0, 0, arCanvas.width, arCanvas.height);

  if (loadedImage) {
    arCtx.drawImage(loadedImage, 0, 0, arCanvas.width, arCanvas.height);
  } else {
    arCtx.fillStyle = '#e2e8f0';
    arCtx.fillRect(0, 0, arCanvas.width, arCanvas.height);
  }

  const cellW = arCanvas.width / 9;
  const cellH = arCanvas.height / 9;

  arCtx.font = 'bold 20px Arial';
  arCtx.textAlign = 'center';
  arCtx.textBaseline = 'middle';

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (grid[r][c] !== 0 && initialGrid[r][c] === 0) {
        arCtx.fillStyle = 'rgba(22, 163, 74, 0.85)';
        arCtx.fillText(String(grid[r][c]), c * cellW + cellW / 2, r * cellH + cellH / 2);
      }
    }
  }
}

imageInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      loadedImage = img;
      drawArOverlay();
      setAvatarState('idle', 'Foto caricata');
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

ocrBtn.addEventListener('click', async () => {
  const file = imageInput.files?.[0];
  if (!file) {
    feedbackBox.textContent = 'Seleziona prima un immagine del Sudoku.';
    return;
  }

  setAvatarState('thinking', 'Analisi OCR...');
  feedbackBox.textContent = 'Analisi immagine in corso...';

  const base64Full = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });

  const imageBase64 = String(base64Full).split(',')[1];

  try {
    const res = await fetch('/api/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64, mimeType: file.type || 'image/jpeg' })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Errore OCR');

    grid = data.grid.map((row) => [...row]);
    initialGrid = data.grid.map((row) => [...row]);
    currentHint = null;
    renderGrid();
    drawArOverlay();
    setAvatarState('happy', 'Griglia letta');
    feedbackBox.textContent = 'Griglia 9x9 estratta con successo.';
  } catch (err) {
    setAvatarState('error', 'Errore OCR');
    feedbackBox.textContent = err.message;
  }
});

async function ensureHintLoaded() {
  if (currentHint) return currentHint;
  setAvatarState('thinking', 'Calcolo hint...');
  const res = await fetch('/api/hint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grid })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Errore hint');
  currentHint = data;
  return currentHint;
}

hintLevel1Btn.addEventListener('click', async () => {
  try {
    const hint = await ensureHintLoaded();
    const blockNum = Math.floor(hint.row / 3) * 3 + Math.floor(hint.col / 3) + 1;
    renderGrid({ highlightBlock: true });
    setAvatarState('thinking', 'Blocco evidenziato');
    feedbackBox.textContent = `Livello 1: la prossima mossa si trova nel blocco 3x3 numero ${blockNum}.`;
  } catch (err) {
    setAvatarState('error', 'Errore');
    feedbackBox.textContent = err.message;
  }
});

hintLevel2Btn.addEventListener('click', async () => {
  try {
    const hint = await ensureHintLoaded();
    renderGrid({ highlightBlock: true, highlightCell: true });
    setAvatarState('thinking', 'Cella indicata');
    feedbackBox.textContent = `Livello 2: osserva la cella in riga ${hint.row + 1}, colonna ${hint.col + 1}.`;
  } catch (err) {
    setAvatarState('error', 'Errore');
    feedbackBox.textContent = err.message;
  }
});

hintLevel3Btn.addEventListener('click', async () => {
  try {
    const hint = await ensureHintLoaded();
    grid[hint.row][hint.col] = hint.valore;
    renderGrid({ highlightBlock: true, highlightCell: true, revealValue: true });
    drawArOverlay();
    setAvatarState('happy', 'Numero rivelato');
    feedbackBox.textContent = `Livello 3: inserisci ${hint.valore} in riga ${hint.row + 1}, colonna ${hint.col + 1}. ${hint.spiegazione}`;
    speakText(hint.spiegazione);
    currentHint = null;
  } catch (err) {
    setAvatarState('error', 'Errore');
    feedbackBox.textContent = err.message;
  }
});

solveBtn.addEventListener('click', async () => {
  setAvatarState('thinking', 'Risoluzione...');
  try {
    const res = await fetch('/api/solve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grid })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Errore risoluzione');

    grid = data.solved.map((row) => [...row]);
    currentHint = null;
    renderGrid();
    drawArOverlay();
    setAvatarState('happy', 'Sudoku risolto');
    feedbackBox.textContent = 'Griglia completata tramite algoritmo Backtracking.';
  } catch (err) {
    setAvatarState('error', 'Errore');
    feedbackBox.textContent = err.message;
  }
});

clearBtn.addEventListener('click', () => {
  grid = Array.from({ length: 9 }, () => Array(9).fill(0));
  initialGrid = Array.from({ length: 9 }, () => Array(9).fill(0));
  currentHint = null;
  renderGrid();
  drawArOverlay();
  setAvatarState('idle', 'Griglia svuotata');
  feedbackBox.textContent = '';
});

renderGrid();
drawArOverlay();