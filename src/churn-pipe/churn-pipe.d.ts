/// <reference path='../freedom/typings/udp-socket.d.ts' />
/// <reference path='../third_party/typings/es6-promise/es6-promise.d.ts' />

// TODO: rename once https://github.com/Microsoft/TypeScript/issues/52 is fixed
declare module freedom_ChurnPipe {
  interface Message {
    data: ArrayBuffer
    source: Endpoint
  }

  interface Endpoint {
    address: string;
    port: number;
  }
}

// TODO: uncomment once https://github.com/Microsoft/TypeScript/issues/52 is fixed
// declare module freedom {
  interface freedom_ChurnPipe {
    bind(
        localAddress :string,
        localPort :number,
        remoteAddress :string,
        remotePort :number,
        transformerName :string,
        key ?:ArrayBuffer,
        config ?:string) : Promise<void>;
    send(buffer :ArrayBuffer) : Promise<void>;
    sendTo(buffer :ArrayBuffer, to :freedom_ChurnPipe.Endpoint) : Promise<void>;

    getLocalEndpoint() : Promise<freedom_ChurnPipe.Endpoint>;

    on(t:'message', f:(message:freedom_ChurnPipe.Message) => any) : void;
    on(t:string, f:Function) : void;

    providePromises(provider:any) : void;
  }
// }

interface Freedom {
  churnPipe() : freedom_ChurnPipe;
}