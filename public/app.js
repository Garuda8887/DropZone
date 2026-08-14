const socket = io();

// UI Elements
const screenConnect = document.getElementById('screen-connect');
const screenTransfer = document.getElementById('screen-transfer');
const btnCreateRoom = document.getElementById('btn-create-room');
const roomCodeDisplay = document.getElementById('room-code-display');
const generatedCode = document.getElementById('generated-code');
const btnJoinRoom = document.getElementById('btn-join-room');
const inputRoomCode = document.getElementById('input-room-code');
const joinError = document.getElementById('join-error');
const activeRoomId = document.getElementById('active-room-id');

// Transfer UI
const dropzone = document.getElementById('file-dropzone');
const fileInput = document.getElementById('file-input');
const progressContainer = document.getElementById('transfer-progress-container');
const progressCircleValue = document.getElementById('progress-circle-value');
const progressTextPercent = document.getElementById('progress-text-percent');
const statusText = document.getElementById('transfer-status-text');
const receivedFilesContainer = document.getElementById('received-files');
const fileList = document.getElementById('file-list');

// WebRTC State
let peerConnection;
let dataChannel;
let isInitiator = false;
let currentRoom = null;

// File Transfer State (Receiving)
let receiveBuffer = [];
let receivedSize = 0;
let incomingFileInfo = null;

// File Transfer State (Sending)
let fileQueue = [];
let isSending = false;

const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }
    ]
};

// --- Socket.io Signaling ---

btnCreateRoom.addEventListener('click', () => {
    const roomId = Math.floor(1000 + Math.random() * 9000).toString(); // 4 digit code
    socket.emit('join-room', roomId);
    btnCreateRoom.disabled = true;
});

btnJoinRoom.addEventListener('click', () => {
    const roomId = inputRoomCode.value.trim();
    if (roomId.length !== 4) {
        showError('Please enter a valid 4-digit code.');
        return;
    }
    socket.emit('join-room', roomId);
});

socket.on('room-created', (roomId) => {
    isInitiator = true;
    currentRoom = roomId;
    roomCodeDisplay.classList.remove('hidden');
    generatedCode.textContent = roomId;
});

socket.on('room-joined', (roomId) => {
    isInitiator = false;
    currentRoom = roomId;
    setupWebRTC();
    // Non-initiator doesn't create offer, waits for initiator
    showTransferScreen(roomId);
});

socket.on('peer-joined', (peerId) => {
    console.log('Peer joined, setting up WebRTC');
    setupWebRTC();
    showTransferScreen(currentRoom);
});

socket.on('room-full', () => {
    showError('Room is full (max 2 devices).');
});

socket.on('signal', async (data) => {
    if (!peerConnection) setupWebRTC();

    try {
        if (data.signal.type === 'offer') {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.signal));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            socket.emit('signal', { room: currentRoom, signal: peerConnection.localDescription });
        } else if (data.signal.type === 'answer') {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.signal));
        } else if (data.signal.candidate) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(data.signal));
        }
    } catch (e) {
        console.error('Error handling signal:', e);
    }
});


// --- WebRTC Setup ---

function setupWebRTC() {
    peerConnection = new RTCPeerConnection(configuration);

    // Send any ice candidates to the other peer
    peerConnection.onicecandidate = ({ candidate }) => {
        if (candidate) {
            socket.emit('signal', { room: currentRoom, signal: candidate });
        }
    };

    peerConnection.onconnectionstatechange = () => {
        console.log('Connection state:', peerConnection.connectionState);
        if (peerConnection.connectionState === 'connected') {
            document.querySelector('.status-indicator').style.boxShadow = '0 0 15px var(--success)';
        } else if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed') {
            document.querySelector('.status-indicator').style.background = 'var(--error)';
            document.querySelector('.status-indicator').style.boxShadow = '0 0 10px var(--error)';
            alert("Peer disconnected.");
        }
    };

    if (isInitiator) {
        // Initiator creates the data channel
        dataChannel = peerConnection.createDataChannel('fileTransfer');
        setupDataChannel();

        // Create offer
        peerConnection.createOffer().then(offer => {
            return peerConnection.setLocalDescription(offer);
        }).then(() => {
            socket.emit('signal', { room: currentRoom, signal: peerConnection.localDescription });
        });
    } else {
        // Receiver waits for data channel
        peerConnection.ondatachannel = (event) => {
            dataChannel = event.channel;
            setupDataChannel();
        };
    }
}

function setupDataChannel() {
    dataChannel.binaryType = 'arraybuffer';
    
    dataChannel.onopen = () => {
        console.log('Data channel open');
        dropzone.style.opacity = '1';
        dropzone.style.pointerEvents = 'auto';
    };

    dataChannel.onmessage = (event) => {
        if (typeof event.data === 'string') {
            // Metadata message
            const meta = JSON.parse(event.data);
            if (meta.type === 'file-start') {
                incomingFileInfo = meta;
                receiveBuffer = [];
                receivedSize = 0;
                
                progressContainer.classList.remove('hidden');
                statusText.textContent = `Receiving: ${meta.name}`;
                updateProgressUI(0);
            } else if (meta.type === 'file-done') {
                finishDownload();
            }
        } else {
            // Binary chunk
            receiveBuffer.push(event.data);
            receivedSize += event.data.byteLength;
            
            if (incomingFileInfo) {
                const percent = (receivedSize / incomingFileInfo.size) * 100;
                updateProgressUI(percent);
            }
        }
    };
}

function updateProgressUI(percent) {
    const circleCircumference = 314;
    const offset = circleCircumference - (percent / 100) * circleCircumference;
    progressCircleValue.style.strokeDashoffset = offset;
    progressTextPercent.textContent = `${Math.round(percent)}%`;
}


// --- File Sending Logic ---

// UI Handlers for Dropzone
dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
});

dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
});

dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
        for (const file of e.dataTransfer.files) {
            fileQueue.push(file);
        }
        processQueue();
    }
});

fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        for (const file of e.target.files) {
            fileQueue.push(file);
        }
        processQueue();
    }
});

function processQueue() {
    if (isSending || fileQueue.length === 0) return;
    
    if (!dataChannel || dataChannel.readyState !== 'open') {
        alert("Wait for the connection to establish.");
        return;
    }

    isSending = true;
    const file = fileQueue.shift();

    progressContainer.classList.remove('hidden');
    statusText.textContent = `Sending: ${file.name} (${fileQueue.length} left)`;
    updateProgressUI(0);

    // Send metadata
    dataChannel.send(JSON.stringify({
        type: 'file-start',
        name: file.name,
        size: file.size,
        fileType: file.type
    }));

    // Chunk size 16KB is safe for WebRTC data channels
    const chunkSize = 16384; 
    let offset = 0;

    const fileReader = new FileReader();

    fileReader.onerror = error => {
        console.error('Error reading file:', error);
        isSending = false;
        processQueue();
    };
    
    fileReader.onabort = () => {
        console.log('File reading aborted');
        isSending = false;
        processQueue();
    };

    fileReader.onload = e => {
        dataChannel.send(e.target.result);
        offset += e.target.result.byteLength;
        
        const percent = (offset / file.size) * 100;
        updateProgressUI(percent);

        if (offset < file.size) {
            readSlice(offset);
        } else {
            // Done
            dataChannel.send(JSON.stringify({ type: 'file-done' }));
            setTimeout(() => {
                if (fileQueue.length > 0) {
                    isSending = false;
                    processQueue();
                } else {
                    statusText.textContent = "All transfers complete!";
                    setTimeout(() => {
                        progressContainer.classList.add('hidden');
                        isSending = false;
                    }, 2000);
                }
            }, 500);
        }
    };

    const readSlice = o => {
        const slice = file.slice(offset, o + chunkSize);
        fileReader.readAsArrayBuffer(slice);
    };

    readSlice(0);
}


// --- File Receiving Logic ---

function finishDownload() {
    const blob = new Blob(receiveBuffer, { type: incomingFileInfo.fileType });
    const url = URL.createObjectURL(blob);
    
    // Add to UI
    receivedFilesContainer.classList.remove('hidden');
    const li = document.createElement('li');
    li.innerHTML = `
        <span>${incomingFileInfo.name} <small>(${(incomingFileInfo.size/1024/1024).toFixed(2)} MB)</small></span>
        <a href="${url}" download="${incomingFileInfo.name}" class="download-link">Download</a>
    `;
    fileList.prepend(li);
    
    statusText.textContent = "File received!";
    setTimeout(() => progressContainer.classList.add('hidden'), 2000);
    
    // Reset state
    incomingFileInfo = null;
    receiveBuffer = [];
    receivedSize = 0;
}


// --- UI Helpers ---

function showError(msg) {
    joinError.textContent = msg;
    joinError.classList.remove('hidden');
    setTimeout(() => joinError.classList.add('hidden'), 3000);
}

function showTransferScreen(roomId) {
    screenConnect.classList.remove('active');
    screenConnect.classList.add('hidden');
    screenTransfer.classList.remove('hidden');
    screenTransfer.classList.add('active');
    activeRoomId.textContent = roomId;
    
    // Disable dropzone until datachannel is open
    dropzone.style.opacity = '0.5';
    dropzone.style.pointerEvents = 'none';
}
