const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

// Ung dung nay hoat dong 100% offline: khong goi mang, khong load bat ky
// tai nguyen tu xa nao. Toan bo logic (parse file, fit mo hinh, ve bieu do)
// chay bang JavaScript thuan trong renderer, khong can Node API o phia
// renderer nen contextIsolation duoc bat mac dinh (an toan hon).

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0f1418',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon_512.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile('index.html');

  // Chan moi dieu huong ra ngoai / mo cua so moi -> mo bang trinh duyet he thong
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
