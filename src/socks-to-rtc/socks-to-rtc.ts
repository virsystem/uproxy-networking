/*
  SocksToRTC.Peer passes socks requests over WebRTC datachannels.
*/
/// <reference path='socks.ts' />
/// <reference path='../../node_modules/freedom-typescript-api/interfaces/freedom.d.ts' />
/// <reference path='../../node_modules/freedom-typescript-api/interfaces/transport.d.ts' />
/// <reference path='../common/arraybuffers.ts' />
/// <reference path='../interfaces/communications.d.ts' />

// TODO replace with a reference to freedom ts interface once it exists.
console.log('WEBWORKER SocksToRtc: ' + self.location.href);

module SocksToRTC {

  var fCore = freedom.core();

  /**
   * SocksToRTC.Peer
   *
   * Contains a local SOCKS server which passes requests remotely through
   * WebRTC peer connections.
   */
  export class Peer {

    private socksServer_:Socks.Server = null;  // Local SOCKS server.
    private signallingChannel_:any = null;     // NAT piercing route.
    private transport_:freedom.Transport = null;     // For actual proxying.

    /**
     * Currently open data channels, indexed by data channel tag name.
     */
    private channels_:{[tag:string]:Channel.EndpointInfo} = {};
    private peerId_:string = null;         // Of the remote rtc-to-net peer.

    // Connection callbacks, by datachannel tag name.
    // TODO: figure out a more elegant way to store these callbacks
    private static connectCallbacks:{[tag:string]:(response:Channel.NetConnectResponse) => void} = {};

    /**
     * Start the Peer, based on the remote peer's info.
     */
    public start = (remotePeer:PeerInfo) => {
      this.reset();  // Begin with fresh components.
      dbg('starting - target peer: ' + JSON.stringify(remotePeer));
      // Bind peerID to scope so promise can work.
      var peerId = this.peerId_ = remotePeer.peerId;
      if (!peerId) {
        dbgErr('no Peer ID provided! cannot connect.');
        return false;
      }
      // SOCKS sessions biject to peerconnection datachannels.
      this.transport_ = freedom['transport']();
      this.transport_.on('onData', this.onDataFromPeer_);
      this.transport_.on('onClose', this.closeConnectionToPeer);
      // Messages received via signalling channel must reach the remote peer
      // through something other than the peerconnection. (e.g. XMPP)
      fCore.createChannel().then((chan) => {
        this.transport_.setup('SocksToRtc-' + peerId, chan.identifier);
        this.signallingChannel_ = chan.channel;
        this.signallingChannel_.on('message', function(msg) {
          freedom.emit('sendSignalToPeer', {
              peerId: peerId,
              data: msg
          });
        });
        dbg('signalling channel to SCTP peer connection ready.');
      });  // fCore.createChannel

      // Create SOCKS server and start listening.
      this.socksServer_ = new Socks.Server(remotePeer.host, remotePeer.port,
                                          this.createChannel_);
      this.socksServer_.listen();
    }

    /**
     * Stop SOCKS server and close data channels and peer connections.
     */
    public reset = () => {
      dbg('resetting peer...');
      if (this.socksServer_) {
        this.socksServer_.disconnect();  // Disconnects internal TCP server.
        this.socksServer_ = null;
      }
      for (var tag in this.channels_) {
        this.closeConnectionToPeer(tag);
      }
      this.channels_ = {};
      if(this.transport_) {
        this.transport_.close();
        this.transport_ = null;
      }
      if (this.signallingChannel_) {  // TODO: is this actually right?
        this.signallingChannel_.emit('close');
      }
      this.signallingChannel_ = null;
      this.peerId_ = null;
    }

    /**
     * Setup a new data channel.
     */
    private createChannel_ = (params:Channel.EndpointInfo) : Promise<Channel.EndpointInfo> => {
      if (!this.transport_) {
        dbgWarn('transport not ready');
        return;
      }

      // Generate a name for this connection and associate it with the SOCKS session.
      var tag = obtainTag();
      this.channels_[tag] = params;

      // This gets a little funky: ask the peer to establish a connection to
      // the remote host and register a callback for when it gets back to us
      // on the control channel.
      // TODO: how to add a timeout, in case the remote end never replies?
      return new Promise((F,R) => {
        Peer.connectCallbacks[tag] = (response:Channel.NetConnectResponse) => {
          if (response.address) {
            var endpointInfo:Channel.EndpointInfo = {
              protocol: params.protocol,
              address: response.address,
              port: response.port,
              send: (buf:ArrayBuffer) => { this.sendToPeer_(tag, buf); },
              terminate: () => { this.terminate_(tag); }
            };
            F(endpointInfo);
          } else {
            R(new Error('could not create datachannel'));
          }
        };
        var request:Channel.NetConnectRequest = {
          protocol: params.protocol,
          address: params.address,
          port: params.port
        };
        var command:Channel.Command = {
          type: Channel.COMMANDS.NET_CONNECT_REQUEST,
          tag: tag,
          data: JSON.stringify(request)
        };
        this.transport_.send('control', ArrayBuffers.stringToArrayBuffer(
            JSON.stringify(command)));
      });
    }

    /**
     * Terminates a data channel.
     */
    private terminate_ = (tag:string) => {
      dbg('terminating datachannel ' + tag);
      var command:Channel.Command = {
          type: Channel.COMMANDS.SOCKS_DISCONNECTED,
          tag: tag
      };
      this.transport_.send('control', ArrayBuffers.stringToArrayBuffer(
          JSON.stringify(command)));
    }

    /**
     * Receive replies proxied back from the remote RtcToNet.Peer and pass them
     * back across underlying SOCKS session / TCP socket.
     */
    private onDataFromPeer_ = (msg:freedom.Transport.IncomingMessage) => {
      dbg(msg.tag + ' <--- received ' + msg.data.byteLength);
      if (!msg.tag) {
        dbgErr('received message without datachannel tag!: ' + JSON.stringify(msg));
        return;
      }

      if (msg.tag == 'control') {
        var command:Channel.Command = JSON.parse(
            ArrayBuffers.arrayBufferToString(msg.data));

        if (command.type === Channel.COMMANDS.NET_CONNECT_RESPONSE) {
          // Call the associated callback and forget about it.
          // The callback should fulfill or reject the promise on
          // which the client is waiting, completing the connection flow.
          var response:Channel.NetConnectResponse = JSON.parse(command.data);
          if (command.tag in Peer.connectCallbacks) {
            var callback = Peer.connectCallbacks[command.tag];
            callback(response);
            Peer.connectCallbacks[command.tag] = undefined;
          } else {
            dbgWarn('received connect callback for unknown datachannel: ' +
                command.tag);
          }
        } else if (command.type === Channel.COMMANDS.NET_DISCONNECTED) {
          // Receiving a disconnect on the remote peer should close SOCKS.
          dbg(command.tag + ' <--- received NET-DISCONNECTED');
          this.closeConnectionToPeer(command.tag);
        } else {
          dbgWarn('unsupported control command: ' + command.type);
        }
      } else {
        if (!(msg.tag in this.channels_)) {
          dbgErr('unknown datachannel ' + msg.tag);
          return;
        }
        var session = this.channels_[msg.tag];
        session.send(msg.data);
      }
    }

    /**
     * Close a particular SOCKS session.
     */
    private closeConnectionToPeer = (tag:string) => {
      dbg('datachannel ' + tag + ' has closed. ending SOCKS session for channel.');
      this.channels_[tag].terminate();
      delete this.channels_[tag];
    }

    /**
     * Send data over SCTP to peer, via data channel |tag|.
     *
     * Side note: When transport_ encounters a 'new' |tag|, it
     * implicitly creates a new data channel.
     */
    private sendToPeer_ = (tag:string, buffer:ArrayBuffer) => {
      if (!this.transport_) {
        dbgWarn('transport_ not ready');
        return;
      }
      dbg('send ' + buffer.byteLength + ' bytes on datachannel ' + tag);
      this.transport_.send(tag, buffer);
    }

    /**
     * Pass any messages coming from remote peer through the signalling channel
     * handled by freedom, which goes to the signalling channel input of the
     * peer connection.
     */
    public handlePeerSignal = (msg:PeerSignal) => {
      // dbg('client handleSignalFromPeer: ' + JSON.stringify(msg) +
                  // ' with state ' + this.toString());
      if (!this.signallingChannel_) {
        dbgErr('signalling channel missing!');
        return;
      }
      this.signallingChannel_.emit('message', msg.data);
    }

    public toString = () => {
      var ret ='<SocksToRTC.Peer: failed toString()>';
      try {
        ret = JSON.stringify({ socksServer: this.socksServer_,
                               transport: this.transport_,
                               peerId: this.peerId_,
                               signallingChannel: this.signallingChannel_,
                               channels: this.channels_ });
      } catch (e) {}
      return ret;
    }

  }  // SocksToRTC.Peer

  // TODO: reuse tag names from a pool.
  function obtainTag() {
    return 'c' + Math.random();
  }

  var modulePrefix_ = '[SocksToRtc] ';
  function dbg(msg:string) { console.log(modulePrefix_ + msg); }
  function dbgWarn(msg:string) { console.warn(modulePrefix_ + msg); }
  function dbgErr(msg:string) { console.error(modulePrefix_ + msg); }

}  // module SocksToRTC


function initClient() {

  // Create local peer and attach freedom message handlers, then emit |ready|.
  var peer = new SocksToRTC.Peer();
  freedom.on('handleSignalFromPeer', peer.handlePeerSignal);
  freedom.on('start', peer.start);
  freedom.on('stop', peer.reset);
  freedom.emit('ready', {});
}


initClient();
