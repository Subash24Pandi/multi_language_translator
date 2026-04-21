export async function convertBlobToWav(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  // Force 16000Hz sample rate for speed and small upload size
  const audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  
  // Force Mono (1 channel) for ultra-fast processing
  const numOfChan = 1;
  const length = audioBuffer.length * numOfChan * 2 + 44;
  const buffer = new ArrayBuffer(length);
  const view = new DataView(buffer);
  
  let offset = 0;
  
  function setUint16(data) {
    view.setUint16(offset, data, true);
    offset += 2;
  }
  
  function setUint32(data) {
    view.setUint32(offset, data, true);
    offset += 4;
  }
  
  // write WAVE header
  setUint32(0x46464952);                         // "RIFF"
  setUint32(length - 8);                         // file length - 8
  setUint32(0x45564157);                         // "WAVE"
  
  setUint32(0x20746d66);                         // "fmt " chunk
  setUint32(16);                                 // length = 16
  setUint16(1);                                  // PCM (uncompressed)
  setUint16(numOfChan);
  setUint32(audioBuffer.sampleRate);
  setUint32(audioBuffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
  setUint16(numOfChan * 2);                      // block-align
  setUint16(16);                                 // 16-bit (hardcoded in this setup)
  
  setUint32(0x61746164);                         // "data" - chunk
  setUint32(length - offset - 4);                // chunk length
  
  // Ultra-fast 1D loop for Mono channel
  const channelData = audioBuffer.getChannelData(0);
  const dataLength = channelData.length;
  
  for (let i = 0; i < dataLength; i++) {
    let sample = channelData[i];
    // Fast clamping and scaling
    sample = sample < -1 ? -1 : (sample > 1 ? 1 : sample);
    sample = (sample < 0 ? sample * 32768 : sample * 32767) | 0;
    view.setInt16(offset, sample, true);
    offset += 2;
  }
  
  return new Blob([buffer], { type: 'audio/wav' });
}
