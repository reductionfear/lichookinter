// ==UserScript==
// @name        Lichook - Lichess Stockfish Helper
// @include     *://lichess.org/*
// @grant       none
// @require     https://raw.githubusercontent.com/reductionfear/lichessb/refs/heads/main/stockfish8.asm.js
// @version     2.0
// @author      0mlml (Adapted for Lichess)
// @description A Lichess.org helper script with Stockfish engine integration and auto-move functionality.
// @run-at      document-start
// ==/UserScript==

(() => {
  'use strict';

  const namespace = 'lichook';
  const VERSION = '2.0';

  // ============================================
  // Configuration & State
  // ============================================
  
  let webSocketWrapper = null;
  let currentFen = "";
  let bestMove = null;
  let chessEngine = null;
  let isEngineReady = false;
  let isCalculating = false;
  let lastCalculatedFen = null;
  let moveHistory = [];
  let uiPanel = null;

  // Settings stored in localStorage
  const defaultSettings = {
    autoMove: false,
    skillLevel: 10,
    depth: 4,
    timeLimitMs: 1000,
    humanLikeTiming: false,
    minDelay: 500,
    maxDelay: 2000,
    debugMode: false,
    showBestMove: true
  };

  const getSettings = () => {
    try {
      const stored = localStorage.getItem(namespace + '_settings');
      return stored ? { ...defaultSettings, ...JSON.parse(stored) } : { ...defaultSettings };
    } catch {
      return { ...defaultSettings };
    }
  };

  const saveSettings = (settings) => {
    try {
      localStorage.setItem(namespace + '_settings', JSON.stringify(settings));
    } catch (e) {
      console.error(`[${namespace}] Failed to save settings:`, e);
    }
  };

  let settings = getSettings();

  // ============================================
  // Console Logging
  // ============================================
  
  const log = (message) => {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${namespace}] [${timestamp}] ${message}`);
    updateConsoleDisplay(message);
  };

  const debug = (message) => {
    if (settings.debugMode) {
      const timestamp = new Date().toLocaleTimeString();
      console.debug(`[${namespace}] [DEBUG] [${timestamp}] ${message}`);
    }
  };

  // ============================================
  // FEN Completion Function
  // ============================================
  
  function completeFen(partialFen) {
    let fenParts = partialFen.split(' ');
    if (fenParts.length === 6) return partialFen;
    // Use '-' for unknown castling rights (safer than assuming full rights)
    // Lichess will provide correct rights when available in the message
    if (fenParts.length === 2) fenParts.push('-');
    if (fenParts.length === 3) fenParts.push('-');
    if (fenParts.length === 4) fenParts.push('0');
    if (fenParts.length === 5) fenParts.push('1');
    return fenParts.join(' ');
  }

  // ============================================
  // WebSocket Interception
  // ============================================
  
  function interceptWebSocket() {
    const originalWebSocket = window.WebSocket;
    
    const webSocketProxy = new Proxy(originalWebSocket, {
      construct: function(target, args) {
        const wrappedWebSocket = new target(...args);
        
        // Only intercept Lichess game WebSockets
        // The script only runs on lichess.org (enforced by @include), but we verify the URL
        const url = args[0] || '';
        let isLichessSocket = false;
        try {
          const parsedUrl = new URL(url, window.location.origin);
          // Check if the host is exactly lichess.org or a subdomain
          isLichessSocket = parsedUrl.hostname === 'lichess.org' || 
                           parsedUrl.hostname.endsWith('.lichess.org') ||
                           parsedUrl.pathname.includes('/socket');
        } catch (e) {
          // If URL parsing fails, check if it's a relative socket path
          isLichessSocket = url.startsWith('/socket') || url.includes('/socket/');
        }
        
        if (isLichessSocket) {
          webSocketWrapper = wrappedWebSocket;
          debug(`WebSocket connected: ${url}`);

          wrappedWebSocket.addEventListener("message", function(event) {
            let message;
            try {
              message = JSON.parse(event.data);
            } catch (e) {
              return;
            }

            switch (message.t) {
              case 'd':
              case 'move':
                if (message.d && typeof message.d.fen === "string") {
                  currentFen = message.d.fen;
                  // In Lichess, ply starts at 0 for initial position (white's turn)
                  // ply 0 = white's turn, ply 1 = black's turn (after white moved), etc.
                  // So even ply = white's turn, odd ply = black's turn
                  const ply = message.d.ply !== undefined ? message.d.ply : 0;
                  let isWhitesTurn = ply % 2 === 0;
                  currentFen += isWhitesTurn ? " w" : " b";
                  currentFen = completeFen(currentFen);
                  
                  debug(`FEN updated: ${currentFen}`);
                  
                  // Calculate move if engine is ready
                  if (isEngineReady && !isCalculating) {
                    calculateMove();
                  }
                }
                break;
              case 'end':
              case 'endData':
                log('Game ended');
                bestMove = null;
                updateBestMoveDisplay(null);
                break;
            }
          });

          wrappedWebSocket.addEventListener("close", function() {
            debug('WebSocket closed');
            if (webSocketWrapper === wrappedWebSocket) {
              webSocketWrapper = null;
            }
          });
        }

        return wrappedWebSocket;
      }
    });

    window.WebSocket = webSocketProxy;
    log('WebSocket interception initialized');
  }

  // ============================================
  // Stockfish Engine Integration
  // ============================================
  
  function initializeChessEngine() {
    try {
      if (typeof STOCKFISH !== 'function') {
        log('Waiting for Stockfish to load...');
        setTimeout(initializeChessEngine, 500);
        return;
      }

      const stockfish = STOCKFISH();
      
      stockfish.postMessage("uci");
      stockfish.postMessage(`setoption name Skill Level value ${settings.skillLevel}`);
      stockfish.postMessage("setoption name Hash value 16");
      stockfish.postMessage("setoption name Threads value 1");
      stockfish.postMessage("ucinewgame");

      chessEngine = {
        postMessage: function(cmd) {
          debug(`Engine command: ${cmd}`);
          stockfish.postMessage(cmd);
        },
        setOnMessage: function(handler) {
          stockfish.onmessage = handler;
        }
      };

      setupChessEngineOnMessage();
      isEngineReady = true;
      log(`Stockfish engine initialized (Skill Level: ${settings.skillLevel}, Depth: ${settings.depth})`);
      
      updateStatusDisplay('Engine Ready');
    } catch (e) {
      console.error(`[${namespace}] Failed to initialize Stockfish:`, e);
      setTimeout(initializeChessEngine, 1000);
    }
  }

  function setupChessEngineOnMessage() {
    chessEngine.setOnMessage(function(event) {
      const message = typeof event === 'string' ? event : (event.data || '');
      
      if (message.includes("bestmove")) {
        isCalculating = false;
        bestMove = message.split(" ")[1];
        
        if (bestMove && bestMove !== '(none)') {
          log(`Best move calculated: ${bestMove}`);
          updateBestMoveDisplay(bestMove);
          
          // Store in history
          moveHistory.push({
            fen: currentFen,
            move: bestMove,
            timestamp: Date.now()
          });
          if (moveHistory.length > 50) moveHistory.shift();
          
          // Auto-move if enabled
          if (settings.autoMove) {
            sendMoveWithDelay(bestMove);
          }
        }
      } else if (message.includes("info depth")) {
        // Extract and display engine info
        const depthMatch = message.match(/depth (\d+)/);
        const scoreMatch = message.match(/score cp (-?\d+)/);
        const mateMatch = message.match(/score mate (-?\d+)/);
        
        if (depthMatch) {
          let info = `Depth: ${depthMatch[1]}`;
          if (mateMatch) {
            info += ` | Mate in ${mateMatch[1]}`;
          } else if (scoreMatch) {
            const score = parseInt(scoreMatch[1]) / 100;
            info += ` | Score: ${score > 0 ? '+' : ''}${score.toFixed(2)}`;
          }
          updateEngineInfo(info);
        }
      }
    });
  }

  function calculateMove() {
    if (!isEngineReady || !currentFen || isCalculating) {
      return;
    }

    // Don't recalculate for the same position
    if (currentFen === lastCalculatedFen) {
      return;
    }

    isCalculating = true;
    lastCalculatedFen = currentFen;
    
    debug(`Calculating move for FEN: ${currentFen}`);
    updateStatusDisplay('Calculating...');
    
    chessEngine.postMessage("position fen " + currentFen);
    chessEngine.postMessage(`go depth ${settings.depth} movetime ${settings.timeLimitMs}`);
  }

  // ============================================
  // Move Sending via WebSocket
  // ============================================
  
  function sendMove(move) {
    if (!webSocketWrapper || webSocketWrapper.readyState !== WebSocket.OPEN) {
      log('Cannot send move: WebSocket not connected');
      return false;
    }

    if (!move || move.length < 4) {
      log('Invalid move format');
      return false;
    }

    try {
      const moveMessage = JSON.stringify({
        t: "move",
        d: { 
          u: move, 
          b: 1, 
          l: 10000, 
          a: 1 
        }
      });
      
      webSocketWrapper.send(moveMessage);
      log(`Move sent: ${move}`);
      
      // Clear best move after sending
      bestMove = null;
      updateBestMoveDisplay(null);
      
      return true;
    } catch (e) {
      console.error(`[${namespace}] Failed to send move:`, e);
      return false;
    }
  }

  function sendMoveWithDelay(move) {
    let delay;
    
    if (settings.humanLikeTiming) {
      // Random delay between min and max
      delay = Math.floor(Math.random() * (settings.maxDelay - settings.minDelay)) + settings.minDelay;
    } else {
      delay = settings.minDelay;
    }
    
    debug(`Sending move with ${delay}ms delay`);
    updateStatusDisplay(`Waiting ${delay}ms...`);
    
    setTimeout(() => {
      sendMove(move);
      updateStatusDisplay('Move sent');
    }, delay);
  }

  // ============================================
  // Floating UI Panel
  // ============================================
  
  function createUI() {
    // Wait for DOM to be ready
    if (!document.body) {
      setTimeout(createUI, 100);
      return;
    }

    // Remove existing panel if present
    const existingPanel = document.getElementById(namespace + '_panel');
    if (existingPanel) {
      existingPanel.remove();
    }

    uiPanel = document.createElement('div');
    uiPanel.id = namespace + '_panel';
    uiPanel.innerHTML = `
      <style>
        #${namespace}_panel {
          position: fixed;
          top: 10px;
          right: 10px;
          width: 280px;
          background: linear-gradient(135deg, #1a1a2e, #16213e);
          border: 1px solid #4a4a6a;
          border-radius: 12px;
          font-family: 'Segoe UI', Tahoma, sans-serif;
          font-size: 12px;
          color: #e0e0e0;
          z-index: 999999;
          box-shadow: 0 8px 32px rgba(0,0,0,0.4);
          user-select: none;
        }
        #${namespace}_header {
          background: linear-gradient(135deg, #4a4a6a, #3a3a5a);
          padding: 10px 14px;
          cursor: move;
          border-radius: 12px 12px 0 0;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        #${namespace}_title {
          font-weight: 600;
          font-size: 14px;
          color: #fff;
        }
        #${namespace}_minimize {
          background: none;
          border: none;
          color: #aaa;
          cursor: pointer;
          font-size: 16px;
          padding: 0 4px;
        }
        #${namespace}_minimize:hover {
          color: #fff;
        }
        #${namespace}_content {
          padding: 14px;
        }
        #${namespace}_content.minimized {
          display: none;
        }
        .${namespace}_row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 10px;
          padding: 8px 10px;
          background: rgba(255,255,255,0.05);
          border-radius: 6px;
        }
        .${namespace}_label {
          font-weight: 500;
          color: #ccc;
        }
        .${namespace}_toggle {
          position: relative;
          width: 40px;
          height: 20px;
          background: #444;
          border-radius: 10px;
          cursor: pointer;
          transition: background 0.3s;
        }
        .${namespace}_toggle.active {
          background: #4caf50;
        }
        .${namespace}_toggle::after {
          content: '';
          position: absolute;
          width: 16px;
          height: 16px;
          background: #fff;
          border-radius: 50%;
          top: 2px;
          left: 2px;
          transition: left 0.3s;
        }
        .${namespace}_toggle.active::after {
          left: 22px;
        }
        .${namespace}_slider {
          width: 80px;
          height: 6px;
          -webkit-appearance: none;
          background: #444;
          border-radius: 3px;
          outline: none;
        }
        .${namespace}_slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 14px;
          height: 14px;
          background: #4caf50;
          border-radius: 50%;
          cursor: pointer;
        }
        .${namespace}_input {
          width: 60px;
          background: #2a2a4a;
          border: 1px solid #4a4a6a;
          border-radius: 4px;
          color: #fff;
          padding: 4px 8px;
          font-size: 11px;
        }
        #${namespace}_bestmove {
          text-align: center;
          padding: 12px;
          background: rgba(76, 175, 80, 0.2);
          border-radius: 8px;
          margin-bottom: 10px;
          font-size: 16px;
          font-weight: 600;
          color: #4caf50;
          min-height: 20px;
        }
        #${namespace}_status {
          text-align: center;
          padding: 6px;
          background: rgba(255,255,255,0.05);
          border-radius: 6px;
          font-size: 11px;
          color: #888;
          margin-bottom: 10px;
        }
        #${namespace}_engineinfo {
          text-align: center;
          padding: 4px;
          font-size: 10px;
          color: #666;
        }
        #${namespace}_console {
          max-height: 80px;
          overflow-y: auto;
          background: #0a0a1a;
          border-radius: 6px;
          padding: 8px;
          font-family: monospace;
          font-size: 10px;
          color: #4caf50;
          margin-top: 10px;
        }
        .${namespace}_btn {
          padding: 8px 12px;
          background: linear-gradient(135deg, #4a4a6a, #3a3a5a);
          border: 1px solid #5a5a7a;
          border-radius: 6px;
          color: #fff;
          cursor: pointer;
          font-size: 11px;
          transition: all 0.2s;
          margin: 2px;
        }
        .${namespace}_btn:hover {
          background: linear-gradient(135deg, #5a5a7a, #4a4a6a);
          transform: translateY(-1px);
        }
        .${namespace}_btn.primary {
          background: linear-gradient(135deg, #4caf50, #388e3c);
          border-color: #4caf50;
        }
        .${namespace}_btn.danger {
          background: linear-gradient(135deg, #f44336, #d32f2f);
          border-color: #f44336;
        }
        .${namespace}_buttons {
          display: flex;
          flex-wrap: wrap;
          justify-content: center;
          margin-top: 10px;
        }
      </style>
      
      <div id="${namespace}_header">
        <span id="${namespace}_title">♟ Lichook v${VERSION}</span>
        <button id="${namespace}_minimize">−</button>
      </div>
      
      <div id="${namespace}_content">
        <div id="${namespace}_bestmove">-</div>
        <div id="${namespace}_status">Initializing...</div>
        <div id="${namespace}_engineinfo"></div>
        
        <div class="${namespace}_row">
          <span class="${namespace}_label">Auto Move</span>
          <div class="${namespace}_toggle ${settings.autoMove ? 'active' : ''}" id="${namespace}_automove_toggle"></div>
        </div>
        
        <div class="${namespace}_row">
          <span class="${namespace}_label">Skill Level</span>
          <input type="range" class="${namespace}_slider" id="${namespace}_skill" min="0" max="20" value="${settings.skillLevel}">
          <span id="${namespace}_skill_val">${settings.skillLevel}</span>
        </div>
        
        <div class="${namespace}_row">
          <span class="${namespace}_label">Depth</span>
          <input type="number" class="${namespace}_input" id="${namespace}_depth" min="1" max="20" value="${settings.depth}">
        </div>
        
        <div class="${namespace}_row">
          <span class="${namespace}_label">Human Timing</span>
          <div class="${namespace}_toggle ${settings.humanLikeTiming ? 'active' : ''}" id="${namespace}_human_toggle"></div>
        </div>
        
        <div class="${namespace}_row">
          <span class="${namespace}_label">Min Delay (ms)</span>
          <input type="number" class="${namespace}_input" id="${namespace}_mindelay" min="100" max="10000" value="${settings.minDelay}">
        </div>
        
        <div class="${namespace}_row">
          <span class="${namespace}_label">Max Delay (ms)</span>
          <input type="number" class="${namespace}_input" id="${namespace}_maxdelay" min="100" max="10000" value="${settings.maxDelay}">
        </div>
        
        <div class="${namespace}_row">
          <span class="${namespace}_label">Debug Mode</span>
          <div class="${namespace}_toggle ${settings.debugMode ? 'active' : ''}" id="${namespace}_debug_toggle"></div>
        </div>
        
        <div class="${namespace}_buttons">
          <button class="${namespace}_btn primary" id="${namespace}_play_btn">▶ Play Move</button>
          <button class="${namespace}_btn" id="${namespace}_calc_btn">🔄 Recalculate</button>
        </div>
        
        <div id="${namespace}_console"></div>
      </div>
    `;

    document.body.appendChild(uiPanel);
    
    // Make panel draggable
    makeDraggable(uiPanel);
    
    // Add event listeners
    setupUIEventListeners();
    
    log('UI panel created');
  }

  function makeDraggable(element) {
    const header = element.querySelector(`#${namespace}_header`);
    let isDragging = false;
    let offsetX, offsetY;

    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true;
      offsetX = e.clientX - element.offsetLeft;
      offsetY = e.clientY - element.offsetTop;
      element.style.transition = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      element.style.left = (e.clientX - offsetX) + 'px';
      element.style.top = (e.clientY - offsetY) + 'px';
      element.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
      element.style.transition = '';
    });
  }

  function setupUIEventListeners() {
    // Minimize button
    document.getElementById(`${namespace}_minimize`).addEventListener('click', () => {
      const content = document.getElementById(`${namespace}_content`);
      const btn = document.getElementById(`${namespace}_minimize`);
      content.classList.toggle('minimized');
      btn.textContent = content.classList.contains('minimized') ? '+' : '−';
    });

    // Auto move toggle
    document.getElementById(`${namespace}_automove_toggle`).addEventListener('click', (e) => {
      e.target.classList.toggle('active');
      settings.autoMove = e.target.classList.contains('active');
      saveSettings(settings);
      log(`Auto move: ${settings.autoMove ? 'ON' : 'OFF'}`);
    });

    // Skill level slider
    const skillSlider = document.getElementById(`${namespace}_skill`);
    skillSlider.addEventListener('input', (e) => {
      settings.skillLevel = parseInt(e.target.value);
      document.getElementById(`${namespace}_skill_val`).textContent = settings.skillLevel;
      saveSettings(settings);
      
      if (isEngineReady) {
        chessEngine.postMessage(`setoption name Skill Level value ${settings.skillLevel}`);
        log(`Skill level set to ${settings.skillLevel}`);
      }
    });

    // Depth input
    document.getElementById(`${namespace}_depth`).addEventListener('change', (e) => {
      settings.depth = Math.max(1, Math.min(20, parseInt(e.target.value) || 4));
      e.target.value = settings.depth;
      saveSettings(settings);
      log(`Depth set to ${settings.depth}`);
    });

    // Human timing toggle
    document.getElementById(`${namespace}_human_toggle`).addEventListener('click', (e) => {
      e.target.classList.toggle('active');
      settings.humanLikeTiming = e.target.classList.contains('active');
      saveSettings(settings);
      log(`Human-like timing: ${settings.humanLikeTiming ? 'ON' : 'OFF'}`);
    });

    // Min delay input
    document.getElementById(`${namespace}_mindelay`).addEventListener('change', (e) => {
      settings.minDelay = Math.max(100, parseInt(e.target.value) || 500);
      e.target.value = settings.minDelay;
      saveSettings(settings);
    });

    // Max delay input
    document.getElementById(`${namespace}_maxdelay`).addEventListener('change', (e) => {
      settings.maxDelay = Math.max(settings.minDelay + 100, parseInt(e.target.value) || 2000);
      e.target.value = settings.maxDelay;
      saveSettings(settings);
    });

    // Debug mode toggle
    document.getElementById(`${namespace}_debug_toggle`).addEventListener('click', (e) => {
      e.target.classList.toggle('active');
      settings.debugMode = e.target.classList.contains('active');
      saveSettings(settings);
      log(`Debug mode: ${settings.debugMode ? 'ON' : 'OFF'}`);
    });

    // Play move button
    document.getElementById(`${namespace}_play_btn`).addEventListener('click', () => {
      if (bestMove) {
        sendMoveWithDelay(bestMove);
      } else {
        log('No move to play');
      }
    });

    // Recalculate button
    document.getElementById(`${namespace}_calc_btn`).addEventListener('click', () => {
      lastCalculatedFen = null;
      calculateMove();
    });
  }

  function updateBestMoveDisplay(move) {
    const element = document.getElementById(`${namespace}_bestmove`);
    if (element) {
      element.textContent = move ? `Best: ${move}` : '-';
      element.style.color = move ? '#4caf50' : '#888';
    }
  }

  function updateStatusDisplay(status) {
    const element = document.getElementById(`${namespace}_status`);
    if (element) {
      element.textContent = status;
    }
  }

  function updateEngineInfo(info) {
    const element = document.getElementById(`${namespace}_engineinfo`);
    if (element) {
      element.textContent = info;
    }
  }

  function updateConsoleDisplay(message) {
    const element = document.getElementById(`${namespace}_console`);
    if (element) {
      const timestamp = new Date().toLocaleTimeString();
      element.innerHTML += `<div>[${timestamp}] ${message}</div>`;
      element.scrollTop = element.scrollHeight;
      
      // Keep only last 20 messages
      while (element.children.length > 20) {
        element.removeChild(element.firstChild);
      }
    }
  }

  // ============================================
  // Keyboard Shortcuts
  // ============================================
  
  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Alt+M - Play best move
      if (e.altKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        if (bestMove) {
          sendMoveWithDelay(bestMove);
        } else {
          log('No move to play');
        }
      }
      
      // Alt+A - Toggle auto move
      if (e.altKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        settings.autoMove = !settings.autoMove;
        saveSettings(settings);
        const toggle = document.getElementById(`${namespace}_automove_toggle`);
        if (toggle) {
          toggle.classList.toggle('active', settings.autoMove);
        }
        log(`Auto move: ${settings.autoMove ? 'ON' : 'OFF'}`);
      }
      
      // Alt+C - Recalculate
      if (e.altKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        lastCalculatedFen = null;
        calculateMove();
      }
      
      // Alt+H - Toggle UI visibility
      if (e.altKey && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        if (uiPanel) {
          uiPanel.style.display = uiPanel.style.display === 'none' ? 'block' : 'none';
        }
      }
    });
    
    log('Keyboard shortcuts: Alt+M (play), Alt+A (toggle auto), Alt+C (recalculate), Alt+H (hide/show)');
  }

  // ============================================
  // Initialization
  // ============================================
  
  function init() {
    log(`Lichook v${VERSION} starting...`);
    
    // Intercept WebSocket (must be done at document-start)
    interceptWebSocket();
    
    // Wait for DOM to create UI and initialize engine
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        createUI();
        initializeChessEngine();
        setupKeyboardShortcuts();
      });
    } else {
      createUI();
      initializeChessEngine();
      setupKeyboardShortcuts();
    }
    
    log('Initialization complete');
  }

  // Start the script
  init();

})();
