describe("socks", function() {
  // A valid SOCKS5/IPV4 request.
  var ipv4Request;

  beforeEach(function() {
    ipv4Request = new Uint8Array([
      Socks.VERSION5,
      Socks.REQUEST_CMD.CONNECT,
      0, // reserved
      Socks.ATYP.IP_V4,
      192, 168, 1, 1, // IP: 192.168.1.1
      1200 >> 8, 1200 & 0xFF]); // port: 1200
  });

  it('reject wrongly sized requests', function() {
    var result = Socks.interpretSocksRequest(
      new Uint8Array(new ArrayBuffer(8)));
    expect(result.failure).toEqual(Socks.RESPONSE.FAILURE);
  });

  it('parse ipv4 request', function() {
    var result = Socks.interpretSocksRequest(ipv4Request);
    expect(result.failure).toBeUndefined();
    expect(result.version).toEqual(Socks.VERSION5);
    expect(result.cmd).toEqual(Socks.REQUEST_CMD.CONNECT);
    expect(result.atyp).toEqual(Socks.ATYP.IP_V4);
    expect(result.addressString).toEqual('192.168.1.1');
    expect(result.port).toEqual(1200);
  });

  it('wrong socks version', function() {
    ipv4Request[0] = 4;
    var result = Socks.interpretSocksRequest(ipv4Request);
    expect(result.failure).toEqual(Socks.RESPONSE.FAILURE);
  });

  it('unsupported command', function() {
    ipv4Request[1] = Socks.REQUEST_CMD.UDP_ASSOCIATE;
    var result = Socks.interpretSocksRequest(ipv4Request);
    expect(result.failure).toEqual(Socks.RESPONSE.UNSUPPORTED_COMMAND);
  });
});
