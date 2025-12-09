/* ==========================================
   KIOSK – PDF SEARCH WEB WORKER
   Handles PDF text search without blocking main thread
   ========================================== */

// Worker state
let indexedPages = [];
let isIndexed = false;

/* ==========================================
   MESSAGE HANDLER
   ========================================== */

self.onmessage = function(e) {
  const { type, pages, query } = e.data;
  
  switch (type) {
    case 'index':
      indexPages(pages);
      break;
    
    case 'search':
      performSearch(query);
      break;
    
    default:
      console.error('Unknown message type:', type);
  }
};

/* ==========================================
   INDEX PAGES
   ========================================== */

function indexPages(pages) {
  try {
    // Store pages with their text content
    indexedPages = pages.map(page => ({
      pageNumber: page.pageNumber,
      text: page.text.toLowerCase(), // Normalize for case-insensitive search
      originalText: page.text
    }));
    
    isIndexed = true;
    
    // Notify main thread that indexing is complete
    self.postMessage({
      type: 'indexComplete',
      pageCount: indexedPages.length
    });
    
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: 'Failed to index PDF: ' + error.message
    });
  }
}

/* ==========================================
   PERFORM SEARCH
   ========================================== */

function performSearch(query) {
  if (!isIndexed || !query) {
    self.postMessage({
      type: 'searchResults',
      matches: []
    });
    return;
  }
  
  try {
    const normalizedQuery = query.toLowerCase();
    const matches = [];
    const maxSnippetLength = 100;
    const contextChars = 40; // Characters before and after match
    
    // Search through all pages
    for (const page of indexedPages) {
      const text = page.text;
      const originalText = page.originalText;
      
      // Find all occurrences of the query in this page
      let index = text.indexOf(normalizedQuery);
      
      while (index !== -1) {
        // Extract snippet around the match
        const snippetStart = Math.max(0, index - contextChars);
        const snippetEnd = Math.min(originalText.length, index + normalizedQuery.length + contextChars);
        
        let snippet = originalText.substring(snippetStart, snippetEnd);
        
        // Add ellipsis if snippet doesn't start/end at document boundaries
        if (snippetStart > 0) snippet = '...' + snippet;
        if (snippetEnd < originalText.length) snippet = snippet + '...';
        
        // Truncate snippet if too long
        if (snippet.length > maxSnippetLength) {
          snippet = snippet.substring(0, maxSnippetLength) + '...';
        }
        
        matches.push({
          pageNumber: page.pageNumber,
          snippet: snippet,
          query: query,
          position: index
        });
        
        // Find next occurrence
        index = text.indexOf(normalizedQuery, index + 1);
        
        // Limit matches per page to avoid overwhelming results
        if (matches.filter(m => m.pageNumber === page.pageNumber).length >= 5) {
          break;
        }
      }
    }
    
    // Sort matches by page number
    matches.sort((a, b) => a.pageNumber - b.pageNumber);
    
    // Limit total results
    const maxResults = 50;
    const limitedMatches = matches.slice(0, maxResults);
    
    // Send results back to main thread
    self.postMessage({
      type: 'searchResults',
      matches: limitedMatches,
      totalMatches: matches.length
    });
    
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: 'Search failed: ' + error.message
    });
  }
}

/* ==========================================
   ERROR HANDLER
   ========================================== */

self.onerror = function(error) {
  console.error('Worker error:', error);
  self.postMessage({
    type: 'error',
    message: error.message
  });
};
