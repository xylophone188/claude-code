import { describe, expect, mock, test } from 'bun:test'
import { WebSocketTransport } from '../WebSocketTransport.js'

type TransportHarness = {
  ws: { send: (data: string) => void }
  onBunMessage: (event: MessageEvent) => void
  onNodeMessage: (data: Buffer) => void
  setOnData: (callback: (data: string) => void) => void
}

function createTransport(): TransportHarness {
  const transport = new WebSocketTransport(
    new URL('ws://localhost:3000'),
  ) as unknown as TransportHarness
  transport.ws = { send: () => undefined }
  return transport
}

describe('WebSocketTransport keep-alive handling', () => {
  test('echoes Bun keep_alive frames without forwarding them', () => {
    const transport = createTransport()
    const send = mock((data: string) => data)
    transport.ws.send = send
    const onData = mock(() => undefined)
    transport.setOnData(onData)

    transport.onBunMessage({ data: '{"type":"keep_alive"}\n' } as MessageEvent)

    expect(send).toHaveBeenCalledWith('{"type":"keep_alive"}\n')
    expect(onData).not.toHaveBeenCalled()
  })

  test('echoes Node keep_alive frames without forwarding them', () => {
    const transport = createTransport()
    const send = mock((data: string) => data)
    transport.ws.send = send
    const onData = mock(() => undefined)
    transport.setOnData(onData)

    transport.onNodeMessage(Buffer.from('{"type":"keep_alive"}\n'))

    expect(send).toHaveBeenCalledWith('{"type":"keep_alive"}\n')
    expect(onData).not.toHaveBeenCalled()
  })

  test('forwards ordinary Bun frames without echoing them', () => {
    const transport = createTransport()
    const send = mock((data: string) => data)
    transport.ws.send = send
    const onData = mock(() => undefined)
    transport.setOnData(onData)

    transport.onBunMessage({ data: '{"type":"user"}\n' } as MessageEvent)

    expect(send).not.toHaveBeenCalled()
    expect(onData).toHaveBeenCalledWith('{"type":"user"}\n')
  })

  test('forwards ordinary Node frames without echoing them', () => {
    const transport = createTransport()
    const send = mock((data: string) => data)
    transport.ws.send = send
    const onData = mock(() => undefined)
    transport.setOnData(onData)

    transport.onNodeMessage(Buffer.from('{"type":"assistant"}\n'))

    expect(send).not.toHaveBeenCalled()
    expect(onData).toHaveBeenCalledWith('{"type":"assistant"}\n')
  })
})
