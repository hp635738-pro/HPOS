import { useEffect, useState } from 'react'

/**
 * Game view — a compact tic-tac-toe arena: play local 2-player or against
 * a simple CPU (win → block → center → corner → random). Scores persist in
 * localStorage so the board remembers your streak across reloads.
 */
const STORE_KEY = 'hpos.gameview.scores.v1'

const WINS = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
]

function winnerOf(b) {
  for (const [a, c, d] of WINS) {
    if (b[a] && b[a] === b[c] && b[a] === b[d]) return { mark: b[a], line: [a, c, d] }
  }
  return b.every(Boolean) ? { mark: 'draw', line: null } : null
}

function cpuMove(b, cpu, human) {
  const empty = b.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0)
  const find = (mark) => {
    for (const line of WINS) {
      const open = line.find((i) => !b[i])
      if (open === undefined) continue
      const marks = line.filter((i) => b[i] === mark).length
      if (marks === 2) return open
    }
    return null
  }
  return find(cpu) ?? find(human) ?? (b[4] ? null : 4)
      ?? [0, 2, 6, 8].find((i) => !b[i])
      ?? empty[Math.floor(Math.random() * empty.length)]
}

function loadScores() {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    const s = raw ? JSON.parse(raw) : null
    return s && typeof s === 'object' ? { x: s.x | 0, o: s.o | 0, draw: s.draw | 0 } : { x: 0, o: 0, draw: 0 }
  } catch { return { x: 0, o: 0, draw: 0 } }
}

export default function GameView() {
  const [board, setBoard] = useState(() => Array(9).fill(null))
  const [turn, setTurn] = useState('X')
  const [vsCpu, setVsCpu] = useState(false)
  const [scores, setScores] = useState(loadScores)
  const result = winnerOf(board)

  useEffect(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(scores)) } catch { /* ignore */ }
  }, [scores])

  // Record the result of a round exactly once.
  useEffect(() => {
    if (!result) return
    setScores((s) => ({
      x: s.x + (result.mark === 'X' ? 1 : 0),
      o: s.o + (result.mark === 'O' ? 1 : 0),
      draw: s.draw + (result.mark === 'draw' ? 1 : 0),
    }))
  }, [result?.mark, board])

  // CPU plays as O after a short beat, only on its turn.
  useEffect(() => {
    if (!vsCpu || result || turn !== 'O') return
    const t = setTimeout(() => {
      const i = cpuMove(board, 'O', 'X')
      if (i === null || i === undefined || i < 0) return
      const next = [...board]
      next[i] = 'O'
      setBoard(next)
      setTurn('X')
    }, 380)
    return () => clearTimeout(t)
  }, [vsCpu, turn, result, board])

  const play = (i) => {
    if (board[i] || result) return
    if (vsCpu && turn === 'O') return // CPU ka turn
    const next = [...board]
    next[i] = turn
    setBoard(next)
    setTurn(turn === 'X' ? 'O' : 'X')
  }

  const newRound = () => {
    setBoard(Array(9).fill(null))
    setTurn('X')
  }

  const resetScores = () => setScores({ x: 0, o: 0, draw: 0 })

  const status = result
    ? result.mark === 'draw' ? 'Draw! Dono barabar.' : `${result.mark} jeet gaya!`
    : vsCpu && turn === 'O' ? 'CPU soch raha hai…' : `Turn: ${turn}`

  return (
    <div style={S.page}>
      <div style={S.inner}>
        {/* Toolbar */}
        <div style={S.card}>
          <div style={S.toolbar}>
            <button
              onClick={() => { setVsCpu((v) => !v); newRound() }}
              style={{ ...(vsCpu ? S.primary : S.ghost), ...S.toggle }}
              title="Toggle CPU opponent"
            >
              {vsCpu ? '🤖 vs CPU' : '👥 2 Player'}
            </button>
            <span style={S.status} data-win={result ? '1' : '0'}>{status}</span>
            <div style={S.actions}>
              <button onClick={newRound} style={S.ghost}>New round</button>
              <button onClick={resetScores} style={S.ghost}>Reset score</button>
            </div>
          </div>
        </div>

        {/* Scoreboard */}
        <div style={S.scoreRow}>
          <Score label="X (Aap)" value={scores.x} accent />
          <Score label="Draws" value={scores.draw} />
          <Score label={vsCpu ? 'O (CPU)' : 'O (Player 2)'} value={scores.o} />
        </div>

        {/* Board */}
        <div style={S.boardWrap}>
          <div style={S.board}>
            {board.map((v, i) => {
              const winning = result?.line?.includes(i)
              return (
                <button
                  key={i}
                  onClick={() => play(i)}
                  disabled={!!v || !!result || (vsCpu && turn === 'O')}
                  style={{ ...S.cell, ...(winning ? S.cellWin : null) }}
                  aria-label={`cell ${i + 1}${v ? ` ${v}` : ''}`}
                >
                  {v && <span style={{ ...S.mark, color: v === 'X' ? 'var(--accent)' : 'var(--warning)' }}>{v}</span>}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function Score({ label, value, accent }) {
  return (
    <div style={{ ...S.score, ...(accent ? S.scoreAccent : null) }}>
      <span style={S.scoreLabel}>{label}</span>
      <span style={S.scoreValue}>{value}</span>
    </div>
  )
}

const S = {
  page: {
    flex: 1, minHeight: 0, overflowY: 'auto',
    padding: 'var(--pad)', color: 'var(--text)',
  },
  inner: {
    maxWidth: 560, margin: '0 auto',
    display: 'flex', flexDirection: 'column', gap: 12,
  },

  card: {
    background: 'var(--elevated)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius-lg)',
    padding: 12,
    boxShadow: 'var(--card-shadow, none)',
  },
  toolbar: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  toggle: { fontSize: 12.5, padding: '8px 14px', whiteSpace: 'nowrap' },
  status: {
    flex: 1, textAlign: 'center',
    fontSize: 13.5, fontWeight: 800, letterSpacing: '-.1px',
    minWidth: 120,
  },
  actions: { display: 'flex', gap: 8 },

  primary: {
    border: 'none', cursor: 'pointer',
    background: 'var(--accent)', color: 'var(--accent-fg)',
    borderRadius: 'var(--radius-sm)', fontWeight: 700,
  },
  ghost: {
    border: '1px solid var(--line)', cursor: 'pointer',
    background: 'transparent', color: 'var(--text)',
    borderRadius: 'var(--radius-sm)', fontWeight: 600,
    fontSize: 12, padding: '8px 12px',
  },

  scoreRow: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 },
  score: {
    background: 'var(--elevated)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius)',
    padding: '10px 12px',
    display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center',
  },
  scoreAccent: { borderColor: 'var(--accent)' },
  scoreLabel: { fontSize: 11, fontWeight: 700, color: 'var(--muted)', whiteSpace: 'nowrap' },
  scoreValue: { fontSize: 20, fontWeight: 800, lineHeight: 1.1 },

  boardWrap: { display: 'flex', justifyContent: 'center' },
  board: {
    display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 8, width: 'min(100%, 340px)',
  },
  cell: {
    aspectRatio: '1 / 1',
    background: 'var(--elevated)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius)',
    cursor: 'pointer', padding: 0,
    display: 'grid', placeItems: 'center',
    boxShadow: 'var(--card-shadow, none)',
  },
  cellWin: {
    borderColor: 'var(--accent)',
    background: 'var(--accent-soft, var(--elevated))',
  },
  mark: {
    fontSize: 34, fontWeight: 800, lineHeight: 1,
    fontFamily: 'inherit', userSelect: 'none',
  },
}
