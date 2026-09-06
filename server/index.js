import cors from 'cors'
import express from 'express'

const app = express()
const port = process.env.PORT || 3001

app.use(cors())
app.use(express.json())

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.listen(port, () => {
  console.log(`HPOS backend listening on http://localhost:${port}`)
})
