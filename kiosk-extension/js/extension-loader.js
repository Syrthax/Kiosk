/* ==========================================
   KIOSK EXTENSION – VIEWER LOADER
   Handles PDF loading from chrome.storage
   ========================================== */

(function() {
  'use strict';

  // Override the home button to open file picker instead
  document.addEventListener('DOMContentLoaded', () => {
    const homeButton = document.getElementById('home-button');
    
    if (homeButton) {
      // Remove existing event listeners by cloning
      const newHomeButton = homeButton.cloneNode(true);
      homeButton.parentNode.replaceChild(newHomeButton, homeButton);
      
      // Add new functionality
      newHomeButton.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        // Create file input
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.pdf,application/pdf';
        fileInput.style.display = 'none';
        
        fileInput.addEventListener('change', (event) => {
          const file = event.target.files[0];
          if (file && file.type === 'application/pdf') {
            // Reload the page with the new file
            const reader = new FileReader();
            reader.onload = (e) => {
              const pdfData = Array.from(new Uint8Array(e.target.result));
              chrome.storage.local.set({ 
                tempPDF: pdfData,
                tempPDFName: file.name
              }, () => {
                window.location.reload();
              });
            };
            reader.readAsArrayBuffer(file);
          }
        });
        
        document.body.appendChild(fileInput);
        fileInput.click();
        document.body.removeChild(fileInput);
      });
    }
  });

  // Check for PDF data in chrome.storage on load
  window.addEventListener('load', () => {
    // Wait for the main viewer.js to initialize
    setTimeout(() => {
      chrome.storage.local.get(['tempPDF', 'tempPDFName'], (result) => {
        if (result.tempPDF && result.tempPDFName) {
          try {
            // Convert array back to Uint8Array
            const uint8Array = new Uint8Array(result.tempPDF);
            
            // Create a blob and load it
            const blob = new Blob([uint8Array], { type: 'application/pdf' });
            
            // Create a File object
            const file = new File([blob], result.tempPDFName, { type: 'application/pdf' });
            
            // Load PDF using the global function from viewer.js
            if (typeof loadPDFFromFile === 'function') {
              loadPDFFromFile(file);
            } else if (typeof window.loadPDFFromFile === 'function') {
              window.loadPDFFromFile(file);
            } else {
              console.error('loadPDFFromFile function not found');
              
              // Fallback: try to use the FileReader and loadPDF
              const reader = new FileReader();
              reader.onload = function(e) {
                const typedarray = new Uint8Array(e.target.result);
                
                if (typeof pdfjsLib !== 'undefined') {
                  pdfjsLib.getDocument({ data: typedarray }).promise.then(pdfDoc => {
                    if (typeof loadPDF === 'function') {
                      // Store reference and call render
                      window.pdfDocument = pdfDoc;
                      window.currentPDFName = result.tempPDFName;
                      
                      // Update UI
                      const pdfNameEl = document.getElementById('pdf-name');
                      if (pdfNameEl) {
                        pdfNameEl.textContent = result.tempPDFName;
                      }
                      
                      // Render pages
                      renderAllPages();
                    }
                  }).catch(error => {
                    console.error('Error loading PDF:', error);
                    const pdfError = document.getElementById('pdf-error');
                    if (pdfError) {
                      pdfError.classList.remove('hidden');
                    }
                  });
                }
              };
              reader.readAsArrayBuffer(file);
            }
            
            // Clear the temp storage after loading
            chrome.storage.local.remove(['tempPDF', 'tempPDFName']);
            
          } catch (error) {
            console.error('Error loading PDF from storage:', error);
          }
        } else {
          // No PDF in storage, show the empty state
          const pdfLoading = document.getElementById('pdf-loading');
          if (pdfLoading) {
            pdfLoading.textContent = 'Select a PDF file to begin';
          }
        }
      });
    }, 500); // Wait half a second for viewer.js to initialize
  });

})();
