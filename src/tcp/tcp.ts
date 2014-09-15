/*
 * This is a TCP server based on Freedom's sockets API.
 */

/// <reference path='../freedom/coreproviders/uproxylogging.d.ts' />
/// <reference path='../freedom/typings/freedom.d.ts' />
/// <reference path='../freedom/typings/tcp-socket.d.ts' />
/// <reference path='../handler/queue.d.ts' />
/// <reference path='../networking-typings/communications.d.ts' />
/// <reference path="../third_party/typings/es6-promise/es6-promise.d.ts" />

module Tcp {
  import TcpLib = freedom_TcpSocket;
  var log :Freedom_UproxyLogging.Log = freedom['core.log']('Tcp');

  // Code for how a Tcp Connection is closed.
  export enum SocketCloseKind {
    WE_CLOSED_IT,
    REMOTELY_CLOSED,
    NEVER_CONNECTED,
    UNKOWN
  }

  // Helper function.
  function endpointOfSocketInfo(info:TcpLib.SocketInfo) : Net.Endpoint {
     return { address: info.peerAddress, port: info.peerPort }
  }

  // A limit on the max number of TCP connections before we start rejecting
  // new ones.
  var DEFAULT_MAX_CONNECTIONS = 1048576;

  // TODO: support starting listening again after stopping
  // TODO: support changing the connection handler.
  // TODO: For dynamic port allocation, provide a way to get the post that we
  // end up listening on.
  // TODO: make endpoint into getter: we don't support changing it by
  // assignment.

  // Tcp.Server: a TCP Server. This listens for connections when listen is
  // called, and handles the new connection as specified by the onConnection
  // argument to the constructor.
  export class Server {
    private serverSocket_ :TcpLib.Socket;
    // TODO: index by connectionId not socketID. More stable & string based.
    private conns:{[socketId:number] : Connection} = {};

    // Create TCP server.
    // `endpoint` = Address and port to be listening on. Port 0 is used for
    // dynamic port allocation.
    // `port` = the port to listen on; 0 = dynamic allocation.
    // `onConnection` = the handler for new TCP Connections.
    // `maxConnections` = the number of connections after which all new ones
    // will be closed as soon as they connect.
    constructor(public endpoint       :Net.Endpoint,
                private onConnection   :(c:Connection) => void,
                public maxConnections ?:number) {
      this.maxConnections = maxConnections || DEFAULT_MAX_CONNECTIONS;
      this.serverSocket_ = freedom['core.tcpsocket']();
      // When `serverSocket_` gets new connections, handle them. This only
      // happens after the server's listen function is called.
      this.serverSocket_.on('onConnection', this.onConnectionHandler_);
    }

    // CONSIDER: use a generic util class for better object management, e.g.
    // below should just be return conns.values().
    public connections = () => {
      var allConnectionsList : Connection[] = [];
      for (var i in this.conns) { allConnectionsList.push(this.conns[i]); }
      return allConnectionsList;
    }

    public connectionsCount = () => {
      return Object.keys(this.conns).length;
    }

    // Listens on the serverSocket_ to `address:port` for new TCP connections.
    // Returns a Promise that this server is now listening with the endpoint it
    // is listening on. If 0 was passed as the port, a dynamic port is chosen.
    public listen = () : Promise<Net.Endpoint> => {
      return this.serverSocket_.listen(this.endpoint.address,
                                       this.endpoint.port)
          .then(this.serverSocket_.getInfo)
          .then((info : freedom_TcpSocket.SocketInfo) => {
            return { address: info.localAddress, port: info.localPort };
          });
    }

    // onConnectionHandler_ is more or less TCP Accept: it is called when a new
    // TCP connection is established.
    private onConnectionHandler_ =
        (acceptValue:TcpLib.ConnectInfo) : void => {
      var socketId = acceptValue.socket;

      // Check that we haven't reach the maximum number of connections
      var connectionsCount = Object.keys(this.conns).length;
      if (connectionsCount >= this.maxConnections) {
        // Stop too many connections.  We create a new socket here from the
        // incoming Id and immediately close it, because we don't yet have a
        // reference to the incomming socket.
        freedom['core.tcpsocket'](socketId).close();
        log.error('Too many connections: ' + connectionsCount);
        return;
      }

      // if we don't know how to handle the connection, so close it.
      if (!this.onConnection) {
        freedom['core.tcpsocket'](socketId).close();
        log.error('No connection handler is defined!');
        return;
      }

      // Create new connection.
      log.debug('Tcp.Server accepted connection on socket id ' + socketId);
      var conn = new Connection({existingSocketId:socketId});
      // When the connection is disconnected correctly, or by error, remove
      // from the server's list of connections.
      conn.onceClosed.then(
        () => {
          delete this.conns[socketId];
          log.debug('Tcp.Server(' + JSON.stringify(this.endpoint) +
              ') : connection closed (' + socketId + '). Conn Count: ' +
              Object.keys(this.conns).length + ']');
        },
        (e) => {
          delete this.conns[socketId];
          log.warn('Tcp.Server(' + JSON.stringify(this.endpoint) +
              ') : connection closed by error (' + socketId + '): ' +
              e.toString() + ' . Conn Count: ' +
              Object.keys(this.conns).length + ']');
        })
      this.conns[socketId] = conn;
      log.debug(this.toString());
      this.onConnection(conn);
    }

    // Mostly useful fro debugging
    public toString = () : string => {
      var s = 'Tcp.Server(' + JSON.stringify(this.endpoint) +
          ') connections: ' + Object.keys(this.conns).length + '\n{';
      for(var socketId in this.conns) {
        s += '  ' + this.conns[socketId].toString() + '\n';
      }
      return s += '}';
    }

    // Closes all active connections.
    public closeAll = () : Promise<void> => {
      var allPromises :Promise<SocketCloseKind>[] = [];

      // Close all Tcp connections.
      for (var i in this.conns) {
        var c = this.conns[i];
        allPromises.push(c.close());
      }

      // Wait for all promises to complete.
      return Promise.all(allPromises).then(() => {
        log.debug('successfully closed all Tcp Connections.');
      });
    }

    public stopListening = () : Promise<void> => {
      // Close the server socket.
      return this.serverSocket_.close().then(() => {
        log.debug('successfully stopped listening for more connections.');
      });
    }

    public shutdown = () : Promise<void> => {
      // This order is important: make sure no new connections happen while
      // we're trying to close all the connections.
      return this.stopListening().then(this.closeAll);
    }
  }  // class Tcp.Server

  // Tcp.Connection - Manages up a single TCP connection.
  export class Connection {
    // Unique identifier for each connection.
    private static globalConnectionId_ :number = 0;

    // Promise for when this connection is closed.
    public onceConnected :Promise<Net.Endpoint>;
    public onceClosed :Promise<SocketCloseKind>;
    // Queue of data to be handled, and the capacity to set a handler and
    // handle the data.
    public dataFromSocketQueue :Handler.Queue<ArrayBuffer,void>;
    public dataToSocketQueue :Handler.Queue<ArrayBuffer, TcpLib.WriteInfo>;

    // Public unique connectionId.
    public connectionId :string;

    // isClosed() === state_ === Connection.State.CLOSED iff onceClosed
    // has been rejected or fulfilled. We use isClosed to ensure that we only
    // fulfill/reject the onceDisconnectd once.
    private state_ :Connection.State;
    // The underlying Freedom TCP socket.
    private connectionSocket_ :TcpLib.Socket;
    // A private function called to invoke fullfil onceClosed.
    private fulfillClosed_ :(reason:SocketCloseKind)=>void;

    // A TCP connection for a given socket.
    constructor(connectionKind:Connection.Kind) {
      this.connectionId = 'N' + Connection.globalConnectionId_++;

      this.dataFromSocketQueue = new Handler.Queue<ArrayBuffer,void>();
      this.dataToSocketQueue =
          new Handler.Queue<ArrayBuffer,TcpLib.WriteInfo>();

      if(Object.keys(connectionKind).length !== 1) {
        log.error(this.connectionId + ': Bad New Tcp Connection Kind:' +
               JSON.stringify(connectionKind));
        this.state_ = Connection.State.ERROR;
        this.onceConnected =
            Promise.reject(new Error(
                this.connectionId + 'Bad New Tcp Connection Kind:' +
                JSON.stringify(connectionKind)));
        this.onceClosed = Promise.resolve(SocketCloseKind.NEVER_CONNECTED);
        return;
      }

      if(connectionKind.existingSocketId) {
        // If we already have an open socket; i.e. from a previous tcp listen.
        // So we get a handler to the old freedom socket.
        this.connectionSocket_ =
            freedom['core.tcpsocket'](connectionKind.existingSocketId);
        this.onceConnected =
            this.connectionSocket_.getInfo().then(endpointOfSocketInfo);
        this.state_ = Connection.State.CONNECTED;
        this.connectionId = this.connectionId + '.A' +
            connectionKind.existingSocketId;
      } else if (connectionKind.endpoint) {
        // Create a new tcp socket to the given endpoint.
        this.connectionSocket_ = freedom['core.tcpsocket']();
        this.onceConnected =
            this.connectionSocket_
                .connect(connectionKind.endpoint.address,
                         connectionKind.endpoint.port)
                .then(this.connectionSocket_.getInfo)
                .then(endpointOfSocketInfo)
        this.state_ = Connection.State.CONNECTING;
        this.onceConnected
            .then(() => {
              // We need this guard because the getInfo call is async and a
              // close may happen affter the freedom socket connects and the
              // getInfo completes.
              if(this.state_ !== Connection.State.CLOSED) {
                this.state_ = Connection.State.CONNECTED;
              }
            });
      } else {
        throw(new Error(this.connectionId +
            ': Should be impossible connectionKind' +
            JSON.stringify(connectionKind)));
      }

      // Use the dataFromSocketQueue handler for data from the socket.
      this.connectionSocket_.on('onData',
          (readInfo:TcpLib.ReadInfo) : void => {
        this.dataFromSocketQueue.handle(readInfo.data);
      });

      // Once we are connected, we start sending data to the underlying socket.
      // |dataToSocketQueue| allows a class using this connection to start
      // queuing data to be send to the socket.
      this.onceConnected.then(() => {
        this.dataToSocketQueue.setHandler(this.connectionSocket_.write);
      });

      this.onceClosed = new Promise<SocketCloseKind>((F, R) => {
        this.fulfillClosed_ = F;
      });
      this.connectionSocket_.on('onDisconnect', this.onDisconnectHandler_);
    }

    // Receive returns a promise for exactly the next |ArrayBuffer| of data.
    public receiveNext = () : Promise<ArrayBuffer> => {
      return new Promise((F,R) => {
        this.dataFromSocketQueue.setSyncNextHandler(F).catch(R);
      });
    }

    // This happens when the Tcp connection is closed by the other end or
    // because  of an error. When closed by the other end, onceDisconnected is
    // fullfilled.  If there's an error, onceDisconnected is rejected with the
    // error.
    private onDisconnectHandler_ = (info:TcpLib.DisconnectInfo) : void => {
      log.debug(this.connectionId + ': onDisconnectHandler_');

      if(this.state_ === Connection.State.CLOSED) {
        log.warn(this.connectionId + ': Got onDisconnect in closed state' +
            '(errcode=' + info.errcode + '; msg=' + info.message + ')');
        return;
      }
      this.state_ = Connection.State.CLOSED;

      if (info.errcode === 'SUCCESS') {
        this.fulfillClosed_(SocketCloseKind.WE_CLOSED_IT);
      } else if (info.errcode === 'CONNECTION_CLOSED') {
        this.fulfillClosed_(SocketCloseKind.REMOTELY_CLOSED);
      } else {
        log.warn(this.connectionId + ': Disconnected with errcode '
          + info.errcode + ': ' + info.message);
        this.fulfillClosed_(SocketCloseKind.UNKOWN);
      }
    }

    // This is called to close the underlying socket. This fulfills the
    // disconnect Promise `onceDisconnected`.
    public close = () : Promise<SocketCloseKind> => {
      log.debug(this.connectionId + ': close');
      if (this.state_ === Connection.State.CLOSED) {
        log.warn(this.connectionId + ': close: called when already closed');
        return;
      }
      this.dataToSocketQueue.stopHandling();
      this.connectionSocket_.close();
      return this.onceClosed;
    }

    // Boolean function to check if this connection is closed;
    public isClosed = () : boolean => {
      return this.state_ === Connection.State.CLOSED;
    };
    public getState = () : Connection.State => {
      return this.state_;
    };

    /**
     * Sends a message that is pre-formatted as an arrayBuffer.
     */
    public send = (msg :ArrayBuffer) : Promise<TcpLib.WriteInfo> => {
      return this.dataToSocketQueue.handle(msg);
    }

    public toString = () => {
      return 'Tcp.Connection(' + this.connectionId + ':' + Connection.State[this.state_] + ')';
    }

  }  // class Tcp.Connection

  // Static stuff for the Connection class.
  export module Connection {
    // Exactly one of the arguments must be specified.
    export interface Kind {
      // To wrap up a connection for an existing socket
      existingSocketId ?:number;
      // TO create a new TCP connection to this target address and port.
      endpoint         ?:Net.Endpoint;
    }

    // Describes the state of a connection.
    export enum State {
      ERROR, // Cannot change state.
      CONNECTING, // Can change to ERROR or CONNECTED.
      CONNECTED, // Can change to ERROR or CLOSED.
      CLOSED // Cannot change state.
    }
  } // module Connection

}  // module TCP