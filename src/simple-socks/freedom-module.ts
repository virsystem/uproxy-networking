/// <reference path='../rtc-to-net/rtc-to-net.d.ts' />
/// <reference path='../socks-to-rtc/socks-to-rtc.d.ts' />

/// <reference path='../webrtc/peerconnection.d.ts' />
/// <reference path='../logging/logging.d.ts' />
/// <reference path='../freedom/typings/freedom.d.ts' />
/// <reference path='../networking-typings/communications.d.ts' />

// Set each module to I, W, E, or D depending on which module
// you're debugging. Since the proxy outputs quite a lot of messages,
// show only warnings by default from the rest of the system.
// Note that the proxy is extremely slow in debug (D) mode.
freedom['loggingprovider']().setConsoleFilter(['*:D']);

var log :Logging.Log = new Logging.Log('simple-socks');

//-----------------------------------------------------------------------------
var localhostEndpoint:Net.Endpoint = { address: '127.0.0.1', port:9999 };

//-----------------------------------------------------------------------------
var pcConfig :freedom_RTCPeerConnection.RTCConfiguration = {
  iceServers: [{urls: ['stun:stun.l.google.com:19302']},
               {urls: ['stun:stun1.l.google.com:19302']}]
};
var rtcNet = new RtcToNet.RtcToNet(
    pcConfig,
    {
      allowNonUnicast: true
    },
    false); // obfuscate

//-----------------------------------------------------------------------------
var socksRtc = new SocksToRtc.SocksToRtc();
socksRtc.on('signalForPeer', rtcNet.handleSignalFromPeer);
socksRtc.start(
    localhostEndpoint,
    pcConfig,
    false) // obfuscate
  .then((endpoint:Net.Endpoint) => {
    log.info('SocksToRtc listening on: ' + JSON.stringify(endpoint));
    log.info('curl -x socks5h://' + endpoint.address + ':' + endpoint.port +
        ' www.example.com')
  }, (e:Error) => {
    log.error('failed to start SocksToRtc: ' + e.message);
  });


//-----------------------------------------------------------------------------

var getterBytesReceived :number = 0;
var getterBytesSent :number = 0;
var giverBytesReceived :number = 0;
var giverBytesSent :number = 0;

rtcNet.signalsForPeer.setSyncHandler(socksRtc.handleSignalFromPeer);

// TODO: Re-enable received/sent messages when per-component logging is fixed:
//         https://github.com/uProxy/uproxy/issues/906
socksRtc.on('bytesReceivedFromPeer', (numBytes:number) => {
  getterBytesReceived += numBytes;
  // log.debug('Getter received ' + numBytes + ' bytes. (Total received: '
  //   + getterBytesReceived + ' bytes)');
});

socksRtc.on('bytesSentToPeer', (numBytes:number) => {
  getterBytesSent += numBytes;
  // log.debug('Getter sent ' + numBytes + ' bytes. (Total sent: '
  //   + getterBytesSent + ' bytes)');
});

rtcNet.bytesReceivedFromPeer.setSyncHandler((numBytes:number) => {
  giverBytesReceived += numBytes;
  // log.debug('Giver received ' + numBytes + ' bytes. (Total received: '
  //   + giverBytesReceived + ' bytes)');
});

rtcNet.bytesSentToPeer.setSyncHandler((numBytes:number) => {
  giverBytesSent += numBytes;
  // log.debug('Giver sent ' + numBytes + ' bytes. (Total sent: '
  //   + giverBytesSent + ' bytes)');
});

rtcNet.onceReady
  .then(() => {
    log.info('RtcToNet ready');
  }, (e:Error) => {
    log.error('failed to start RtcToNet: ' + e.message);
  });
