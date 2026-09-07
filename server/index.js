import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { createClient } from '@supabase/supabase-js'

const app = express()
const port = process.env.PORT || 3001

app.use(cors())
app.use(express.json())

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
)

app.get('/api/health', (req, res) => {
  res.json({ ok: true })
})

app.get('/api/products', async (req, res) => {
  const { data, error } = await supabase
    .from('products')
    .select('*')

  if (error) return res.status(500).json({ error: error.message })

  res.json(data)
})

app.listen(port, () => {
  console.log(`HPOS backend listening on http://localhost:${port}`)
})
