/// <reference path="../../churn/churn.d.ts" />

/// <reference path='../../../build/third_party/freedom-typings/freedom-common.d.ts' />

import peerconnection = require('../../../build/dev/webrtc/peerconnection');
import churn = require('../../churn/churn');

freedom['loggingprovider']().setConsoleFilter(['*:D']);

import logging = require('../../../build/dev/logging/logging');
var log :Logging.Log = new Logging.Log('copypaste churn chat');

var config :freedom_RTCPeerConnection.RTCConfiguration = {
  iceServers: [{urls: ['stun:stun.l.google.com:19302']},
               {urls: ['stun:stun1.l.google.com:19302']}]
};

var freedomPc = freedom['core.rtcpeerconnection'](config);
var pc = new churn.Connection(freedomPc);
var freedomParentModule = freedom();

// Forward signalling channel messages to the UI.
pc.signalForPeerQueue.setSyncHandler((signal:WebRtc.SignallingMessage) => {
  // FIXME: Does signalForPeer want a ChurnSignallingMessage?  How is the stage
  // value supposed to get filled in.
  freedomParentModule.emit('signalForPeer', signal);
});

// Receive signalling channel messages from the UI.
freedomParentModule.on('handleSignalMessage', (signal:churn.ChurnSignallingMessage) => {
  pc.handleSignalMessage(signal);
});

pc.onceConnecting.then(() => { log.info('connecting...'); });


var connectDataChannel = (channel:WebRtc.DataChannel) => {
	// Send messages over the datachannel, in response to events from the UI,
	// and forward messages received on the datachannel to the UI.
	freedomParentModule.on('send', (message:string) => {
    channel.send({ str: message }).catch((e:Error) => {
			log.error('error sending message: ' + e.message);
		});
	});
	channel.dataFromPeerQueue.setSyncHandler((d:WebRtc.Data) => {
		if (d.str === undefined) {
			log.error('only text messages are supported');
			return;
		}
		freedomParentModule.emit('receive', d.str);
	});
};

// TODO: This is messy...would be great just to have both sides
//       call onceConnected but it doesn't seem to fire :-/
pc.peerOpenedChannelQueue.setSyncHandler((channel:WebRtc.DataChannel) => {
  log.info('peer opened datachannel!');
	connectDataChannel(channel);
  freedomParentModule.emit('ready', {});
});

// Negotiate a peerconnection.
freedomParentModule.on('start', () => {
  pc.negotiateConnection().then(() => {
      pc.openDataChannel('text').then((channel:WebRtc.DataChannel) => {
      log.info('datachannel open!');
		  connectDataChannel(channel);
      freedomParentModule.emit('ready', {});
    }, (e) => {
      log.error('could not setup datachannel: ' + e.message);
      freedomParentModule.emit('error', {});
    });
  }, (e) => {
    log.error('could not negotiate peerconnection: ' + e.message);
  });
});
