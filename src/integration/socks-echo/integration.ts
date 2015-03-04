/// <reference path="../../networking-typings/communications.d.ts" />
/// <reference path="../../rtc-to-net/rtc-to-net.d.ts" />
/// <reference path="../../socks-common/socks-headers.d.ts" />
/// <reference path="../../socks-to-rtc/socks-to-rtc.d.ts" />
/// <reference path="../../tcp/tcp.d.ts" />
/// <reference path="../../webrtc/peerconnection.d.ts" />

freedom['loggingprovider']().setConsoleFilter(['*:D']);

class ProxyIntegrationTest {
  private socksToRtc_ :SocksToRtc.SocksToRtc;
  private rtcToNet_ :RtcToNet.RtcToNet;
  private socksEndpoint_ : Promise<Net.Endpoint>;
  private echoServers_ :Tcp.Server[] = [];
  private connections_ :{ [index:string]: Tcp.Connection; } = {};
  private localhost_ :string = '127.0.0.1';

  constructor(private dispatchEvent_:(name:string, args:any) => void,
                                      denyLocalhost?:boolean,
                                      obfuscate?:boolean) {
    this.socksEndpoint_ = this.startSocksPair_(denyLocalhost, obfuscate);
  }

  public startEchoServer = () : Promise<number> => {
    var server = new Tcp.Server({
      address: this.localhost_,
      port: 0
    });

    server.connectionsQueue.setSyncHandler((tcpConnection:Tcp.Connection) => {
      tcpConnection.dataFromSocketQueue.setSyncHandler((buffer:ArrayBuffer) => {
        tcpConnection.send(buffer);
      });
    });

    // Discard endpoint info; we'll get it again later via .onceListening().
    this.echoServers_.push(server);
    return server.listen().then((endpoint:Net.Endpoint) => { return endpoint.port; });
  }

  private startSocksPair_ = (denyLocalhost?:boolean, obfuscate?:boolean) : Promise<Net.Endpoint> => {
    var socksToRtcEndpoint :Net.Endpoint = {
      address: this.localhost_,
      port: 0
    };
    var rtcPcConfig :freedom_RTCPeerConnection.RTCConfiguration = {
      iceServers: [],
    };
    var rtcToNetProxyConfig :RtcToNet.ProxyConfig = {
      allowNonUnicast: !denyLocalhost  // Allow RtcToNet to contact the localhost server.
    };

    this.socksToRtc_ = new SocksToRtc.SocksToRtc();
    this.rtcToNet_ = new RtcToNet.RtcToNet(rtcPcConfig, rtcToNetProxyConfig, obfuscate);
    this.socksToRtc_.on('signalForPeer', this.rtcToNet_.handleSignalFromPeer);
    this.rtcToNet_.signalsForPeer.setSyncHandler(this.socksToRtc_.handleSignalFromPeer);
    return this.socksToRtc_.start(socksToRtcEndpoint, rtcPcConfig, obfuscate);
  }

  // Assumes webEndpoint is IPv4.
  private connectThroughSocks_ = (socksEndpoint:Net.Endpoint, webEndpoint:Net.Endpoint) : Promise<Tcp.Connection> => {
    var connection = new Tcp.Connection({endpoint: socksEndpoint});
    var authRequest = Socks.composeAuthHandshakeBuffer([Socks.Auth.NOAUTH]);
    connection.send(authRequest);
    var connected = new Promise<Tcp.ConnectionInfo>((F, R) => {
      connection.onceConnected.then(F);
      connection.onceClosed.then(R);
    });
    var firstBufferPromise :Promise<ArrayBuffer> = connection.receiveNext();
    return connected.then((i:Tcp.ConnectionInfo) => {
      return firstBufferPromise;
    }).then((buffer:ArrayBuffer) : Promise<ArrayBuffer> => {
      var auth = Socks.interpretAuthResponse(buffer);
      if (auth != Socks.Auth.NOAUTH) {
        throw new Error('SOCKS server returned unexpected AUTH response.  ' +
                        'Expected NOAUTH (' + Socks.Auth.NOAUTH + ') but got ' + auth);
      }

      var request :Socks.Request = {
        command: Socks.Command.TCP_CONNECT,
        endpoint: webEndpoint,
      };
      connection.send(Socks.composeRequestBuffer(request));
      return connection.receiveNext();
    }).then((buffer:ArrayBuffer) : Promise<Tcp.Connection> => {
      var response = Socks.interpretResponseBuffer(buffer);
      if (response.reply != Socks.Reply.SUCCEEDED) {
        return Promise.reject(response);
      }
      return Promise.resolve(connection);
    });
  }

  public connect = (port:number, address?:string) : Promise<string> => {
    try {
      return this.socksEndpoint_.then((socksEndpoint:Net.Endpoint) : Promise<Tcp.Connection> => {
        var echoEndpoint :Net.Endpoint = {
          address: address || this.localhost_,
          port: port
        };
        return this.connectThroughSocks_(socksEndpoint, echoEndpoint);
      }).then((connection:Tcp.Connection) => {
        this.connections_[connection.connectionId] = connection;
        return connection.connectionId;
      });
    } catch (e) {
      return Promise.reject(e.message + ' ' + e.stack);
    }
  }

  public echo = (connectionId:string, content:ArrayBuffer) : Promise<ArrayBuffer> => {
    return this.echoMultiple(connectionId, [content])
        .then((responses:ArrayBuffer[]) : ArrayBuffer => {
          return responses[0];
        });
  }

  public echoMultiple = (connectionId:string, contents:ArrayBuffer[]) : Promise<ArrayBuffer[]> => {
    try {
      var connection = this.connections_[connectionId];
      contents.forEach(connection.send);

      var received :ArrayBuffer[] = [];
      var bytesReceived :number = 0;
      var bytesToSend :number = 0;
      contents.forEach((content:ArrayBuffer) => {
        bytesToSend += content.byteLength;
      });
      return new Promise<ArrayBuffer[]>((F, R) => {
        connection.dataFromSocketQueue.setSyncHandler((echo:ArrayBuffer) => {
          received.push(echo);
          bytesReceived += echo.byteLength;
          if (bytesReceived == bytesToSend) {
            F(received);
          }
        });
      });
    } catch (e) {
      return Promise.reject(e.message + ' ' + e.stack);
    }
  }

  public ping = (connectionId:string, content:ArrayBuffer) : Promise<void> => {
    try {
      var connection = this.connections_[connectionId];
      connection.send(content);
      connection.dataFromSocketQueue.setSyncHandler((response:ArrayBuffer) => {
        this.dispatchEvent_('pong', response);
      });
      return Promise.resolve<void>();
    } catch (e) {
      return Promise.reject(e.message + ' ' + e.stack);
    }
  }
}

interface Freedom {
  providePromises: (a:new (f:any) => ProxyIntegrationTest) => void;
};

if (typeof freedom !== 'undefined') {
  freedom().providePromises(ProxyIntegrationTest);
}