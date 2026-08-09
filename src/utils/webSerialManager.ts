import type { MachineStatus } from '../types/etch';

type StatusListener = (status: MachineStatus) => void;

class WebSerialManager {
  private port: any = null;
  private reader: any = null;
  private writer: any = null;
  private statusListeners: Set<StatusListener> = new Set();
  private isReading = false;
  private status: MachineStatus = {
    connected: false,
    baudRate: 115200,
    state: 'Disconnected',
    x: 0,
    y: 0,
    z: 0,
    feedRate: 0,
    spindlePower: 0,
  };

  public subscribe(listener: StatusListener) {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  private notify() {
    for (const listener of this.statusListeners) {
      listener({ ...this.status });
    }
  }

  public isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  public async connect(baudRate: number = 115200): Promise<boolean> {
    if (!this.isSupported()) {
      alert('Web Serial API is not supported in this browser. Use Chrome or Edge.');
      return false;
    }

    try {
      this.port = await (navigator as any).serial.requestPort();
      await this.port.open({ baudRate });
      this.status.connected = true;
      this.status.baudRate = baudRate;
      this.status.state = 'Idle';
      this.notify();

      const textEncoder = new TextEncoderStream();
      textEncoder.readable.pipeTo(this.port.writable);
      this.writer = textEncoder.writable.getWriter();

      this.startReading();
      return true;
    } catch (err: any) {
      console.error('Failed to connect Web Serial:', err);
      this.status.connected = false;
      this.status.state = 'Disconnected';
      this.notify();
      return false;
    }
  }

  public async disconnect() {
    this.isReading = false;
    if (this.reader) {
      await this.reader.cancel();
      this.reader = null;
    }
    if (this.writer) {
      await this.writer.close();
      this.writer = null;
    }
    if (this.port) {
      await this.port.close();
      this.port = null;
    }
    this.status.connected = false;
    this.status.state = 'Disconnected';
    this.notify();
  }

  public async sendCommand(cmd: string) {
    if (!this.writer || !this.status.connected) {
      console.warn('Machine not connected');
      return;
    }
    const data = cmd.endsWith('\n') ? cmd : `${cmd}\n`;
    await this.writer.write(data);
  }

  public async jog(axis: 'X' | 'Y' | 'Z', distance: number, feedRate: number = 1000) {
    const cmd = `$J=G91 ${axis}${distance} F${feedRate}`;
    await this.sendCommand(cmd);
  }

  public async zeroAxis(axis: 'X' | 'Y' | 'Z' | 'ALL') {
    if (axis === 'ALL') {
      await this.sendCommand('G92 X0 Y0 Z0');
    } else {
      await this.sendCommand(`G92 ${axis}0`);
    }
  }

  public async home() {
    await this.sendCommand('$H');
  }

  public async softReset() {
    await this.sendCommand('$X');
  }

  public async emergencyStop() {
    await this.sendCommand('M5');
    await this.sendCommand('!');
    this.status.state = 'Hold';
    this.notify();
  }

  private async startReading() {
    if (!this.port || !this.port.readable) return;
    this.isReading = true;

    const textDecoder = new TextDecoderStream();
    this.port.readable.pipeTo(textDecoder.writable);
    this.reader = textDecoder.readable.getReader();

    let buffer = '';

    try {
      while (this.isReading) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) {
          buffer += value;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            this.handleIncomingLine(line.trim());
          }
        }
      }
    } catch (err) {
      console.error('Serial read error:', err);
    }
  }

  private handleIncomingLine(line: string) {
    if (!line) return;
    this.status.lastResponse = line;

    // Parse GRBL status string e.g. <Idle|MPos:10.000,20.000,0.000|FS:0,0>
    if (line.startsWith('<') && line.endsWith('>')) {
      const content = line.substring(1, line.length - 1);
      const parts = content.split('|');
      const state = parts[0] as any;
      this.status.state = state;

      for (const part of parts.slice(1)) {
        if (part.startsWith('MPos:') || part.startsWith('WPos:')) {
          const coords = part.split(':')[1].split(',').map(Number);
          this.status.x = coords[0] || 0;
          this.status.y = coords[1] || 0;
          this.status.z = coords[2] || 0;
        } else if (part.startsWith('FS:')) {
          const fs = part.split(':')[1].split(',').map(Number);
          this.status.feedRate = fs[0] || 0;
          this.status.spindlePower = fs[1] || 0;
        }
      }
    }

    this.notify();
  }
}

export const webSerialManager = new WebSerialManager();
