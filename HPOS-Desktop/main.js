const { app, BrowserWindow } = require('electron')
const path = require('path')

const DEV_URL = process.env.HPOS_DEV_URL || null

function createWindow() {
  return new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'HPOS',
    backgroundColor: '#0f1013',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
}

function loadContent(win) {
  if (DEV_URL) {
    // Dev mode: show the running Vite dev server of the main HPOS project.
    win.loadURL(DEV_URL)
  } else {
    win.loadFile(path.join(__dirname, 'index.html'))
  }
}

app.whenReady().then(() => {
  const win = createWindow()
  win.once('ready-to-show', () => win.show())
  loadContent(win)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const w = createWindow()
      w.once('ready-to-show', () => w.show())
      loadContent(w)
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
