/// <reference path="../../churn/churn.d.ts" />
/// <reference path="../../webrtc/peerconnection.d.ts" />
/// <reference path="../../freedom/typings/freedom.d.ts" />
/// <reference path="../../freedom/typings/rtcpeerconnection.d.ts" />
/// <reference path='../../logging/logging.d.ts' />

freedom['loggingprovider']().setConsoleFilter(['*:D']);

var log :Logging.Log = new Logging.Log('simple churn chat');

var config :freedom_RTCPeerConnection.RTCConfiguration = {
  iceServers: [{urls: ['stun:stun.l.google.com:19302']},
               {urls: ['stun:stun1.l.google.com:19302']}]
};

var pcA = freedom['core.rtcpeerconnection'](config);
var a :Churn.Connection = new Churn.Connection(pcA);
var pcB = freedom['core.rtcpeerconnection'](config);
var b :Churn.Connection = new Churn.Connection(pcB);

// Connect the two signalling channels.
// Normally, these messages would be sent over the internet.
a.signalForPeerQueue.setSyncHandler((signal:Churn.ChurnSignallingMessage) => {
  log.info('signalling channel A message: ' + JSON.stringify(signal));
  b.handleSignalMessage(signal);
});
b.signalForPeerQueue.setSyncHandler((signal:Churn.ChurnSignallingMessage) => {
  log.info('signalling channel B message: ' + JSON.stringify(signal));
  a.handleSignalMessage(signal);
});

// Send messages over the datachannel, in response to events from the UI.
var sendMessage = (channel:WebRtc.DataChannel, message:string) => {
  channel.send({ str: message }).catch((e) => {
    log.error('error sending message: ' + e.message);
  });
};

// Handle messages received on the datachannel(s).
// The message is forwarded to the UI.
var receiveMessage = (name:string, d:WebRtc.Data) => {
    if (d.str === undefined) {
		log.error('only text messages are supported');
		return;
    }
    freedom().emit('receive' + name, d.str);
};

b.peerOpenedChannelQueue.setSyncHandler((channel:WebRtc.DataChannel) => {
	log.info('i can see that `a` created a data channel called ' + channel.getLabel());
	freedom().on('sendB', sendMessage.bind(null, channel));
	channel.dataFromPeerQueue.setHandler(receiveMessage.bind(null, 'B'));
});

a.onceConnecting.then(() => { log.info('a is connecting...'); });
b.onceConnecting.then(() => { log.info('b is connecting...'); });

// Log the fact that the specified connection is connected.
function logConnected(name:string) {
  log.info(name + ' connected');
}
a.onceConnected.then(logConnected.bind(null, 'a'));
b.onceConnected.then(logConnected.bind(null, 'b'));

// Negotiate a peerconnection.
// Once negotiated, enable the UI and add send/receive handlers.
a.negotiateConnection().then(() => {
  a.openDataChannel('text').then((channel:WebRtc.DataChannel) => {
    log.info('datachannel open!');
    freedom().on('sendA', sendMessage.bind(null, channel));
    channel.dataFromPeerQueue.setHandler(receiveMessage.bind(null, 'A'));
    freedom().emit('ready', {});
  }, (e) => {
    log.error('could not setup datachannel: ' + e.message);
    freedom().emit('error', {});
  });
}, (e) => {
  log.error('could not negotiate peerconnection: ' + e.message);
});
