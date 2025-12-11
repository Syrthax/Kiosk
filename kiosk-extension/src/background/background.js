// Simple background script to open viewer
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({
    url: chrome.runtime.getURL('viewer.html')
  });
});

// Keyboard shortcuts
chrome.commands.onCommand.addListener((command) => {
  if (command === 'open-viewer') {
    chrome.tabs.create({
      url: chrome.runtime.getURL('viewer.html')
    });
  }
});

console.log('Kiosk Extension loaded');
