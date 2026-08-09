import React, { useState, useEffect } from 'react';
import { useStore } from '../store/useStore';
import { webSerialManager } from '../utils/webSerialManager';
import type { MachineStatus } from '../types/etch';
import { X, Cpu, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, AlertTriangle } from 'lucide-react';

export const MachineControlModal: React.FC = () => {
  const { isMachineModalOpen, toggleMachineModal } = useStore();
  const [status, setStatus] = useState<MachineStatus>({
    connected: false,
    baudRate: 115200,
    state: 'Disconnected',
    x: 0,
    y: 0,
    z: 0,
    feedRate: 0,
    spindlePower: 0,
  });
  const [jogStep, setJogStep] = useState(10);
  const [consoleInput, setConsoleInput] = useState('');

  useEffect(() => {
    const unsub = webSerialManager.subscribe((s) => setStatus(s));
    return () => {
      unsub();
    };
  }, []);

  if (!isMachineModalOpen) return null;

  const handleConnect = async () => {
    await webSerialManager.connect(115200);
  };

  const handleDisconnect = async () => {
    await webSerialManager.disconnect();
  };

  const handleConsoleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (consoleInput.trim()) {
      webSerialManager.sendCommand(consoleInput.trim());
      setConsoleInput('');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-md p-4">
      <div className="w-full max-w-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col h-[80vh] transition-colors">
        {/* Header */}
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cpu className="w-5 h-5 text-amber-500" />
            <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100 uppercase tracking-wide">
              Direct Laser &amp; CNC Machine Control (Web Serial)
            </h2>
          </div>
          <button
            onClick={toggleMachineModal}
            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 grid grid-cols-2 p-6 gap-6 overflow-hidden">
          {/* Left: Connection Status & Jog Controller */}
          <div className="space-y-4 flex flex-col">
            {/* Connection Status */}
            <div className="p-4 bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/80 rounded-xl flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                  Status: <span className="text-amber-500 font-bold uppercase">{status.state}</span>
                </div>
                <div className="text-[10px] text-slate-500 dark:text-slate-400 font-mono">
                  X: {status.x.toFixed(2)} | Y: {status.y.toFixed(2)} | Z: {status.z.toFixed(2)} mm
                </div>
              </div>
              {status.connected ? (
                <button
                  onClick={handleDisconnect}
                  className="px-3 py-1.5 bg-red-100 dark:bg-red-950/80 hover:bg-red-200 dark:hover:bg-red-900 border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 text-xs rounded-lg transition-colors cursor-pointer"
                >
                  Disconnect
                </button>
              ) : (
                <button
                  onClick={handleConnect}
                  className="px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-white font-bold text-xs rounded-lg shadow-md shadow-amber-500/20 transition-all cursor-pointer"
                >
                  Connect Web Serial
                </button>
              )}
            </div>

            {/* Jog Keypad */}
            <div className="p-4 bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 rounded-xl flex flex-col items-center gap-3">
              <div className="text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase">Interactive X/Y Jog</div>

              {/* Step Size Selector */}
              <div className="flex items-center gap-1.5 text-[10px]">
                {[1, 5, 10, 50].map((step) => (
                  <button
                    key={step}
                    onClick={() => setJogStep(step)}
                    className={`px-2 py-0.5 rounded font-mono cursor-pointer ${
                      jogStep === step
                        ? 'bg-amber-500 text-white font-bold'
                        : 'bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                    }`}
                  >
                    {step}mm
                  </button>
                ))}
              </div>

              {/* D-Pad Buttons */}
              <div className="grid grid-cols-3 gap-2 w-36 h-36">
                <div />
                <button
                  onClick={() => webSerialManager.jog('Y', jogStep)}
                  disabled={!status.connected}
                  className="bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 disabled:opacity-30 rounded-lg flex items-center justify-center text-amber-600 dark:text-amber-400 cursor-pointer"
                >
                  <ArrowUp className="w-5 h-5" />
                </button>
                <div />
                <button
                  onClick={() => webSerialManager.jog('X', -jogStep)}
                  disabled={!status.connected}
                  className="bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 disabled:opacity-30 rounded-lg flex items-center justify-center text-amber-600 dark:text-amber-400 cursor-pointer"
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
                <button
                  onClick={() => webSerialManager.zeroAxis('ALL')}
                  disabled={!status.connected}
                  className="bg-amber-100 dark:bg-amber-950/80 hover:bg-amber-200 dark:hover:bg-amber-900 border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 rounded-lg flex items-center justify-center text-[10px] font-bold cursor-pointer"
                  title="Zero X/Y/Z"
                >
                  ZERO
                </button>
                <button
                  onClick={() => webSerialManager.jog('X', jogStep)}
                  disabled={!status.connected}
                  className="bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 disabled:opacity-30 rounded-lg flex items-center justify-center text-amber-600 dark:text-amber-400 cursor-pointer"
                >
                  <ArrowRight className="w-5 h-5" />
                </button>
                <div />
                <button
                  onClick={() => webSerialManager.jog('Y', -jogStep)}
                  disabled={!status.connected}
                  className="bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 disabled:opacity-30 rounded-lg flex items-center justify-center text-amber-600 dark:text-amber-400 cursor-pointer"
                >
                  <ArrowDown className="w-5 h-5" />
                </button>
                <div />
              </div>

              {/* Action Buttons: Home & E-Stop */}
              <div className="flex items-center gap-2 w-full pt-2">
                <button
                  onClick={() => webSerialManager.home()}
                  disabled={!status.connected}
                  className="flex-1 py-1.5 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 text-xs rounded-lg flex items-center justify-center gap-1 cursor-pointer"
                >
                  <Home className="w-3.5 h-3.5 text-cyan-500" />
                  <span>Home ($H)</span>
                </button>
                <button
                  onClick={() => webSerialManager.emergencyStop()}
                  disabled={!status.connected}
                  className="flex-1 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded-lg flex items-center justify-center gap-1 cursor-pointer shadow-md shadow-red-500/20"
                >
                  <AlertTriangle className="w-3.5 h-3.5" />
                  <span>E-STOP</span>
                </button>
              </div>
            </div>
          </div>

          {/* Right: GRBL Terminal Console */}
          <div className="flex flex-col h-full bg-slate-900 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
            <div className="text-[10px] uppercase font-mono text-slate-400 mb-2">GRBL Serial Terminal Output</div>
            <div className="flex-1 overflow-y-auto font-mono text-[11px] text-amber-400 leading-relaxed">
              <div>&gt; Connected to Web Serial Terminal</div>
              {status.lastResponse && <div>&lt; {status.lastResponse}</div>}
            </div>

            <form onSubmit={handleConsoleSubmit} className="mt-3 flex gap-2">
              <input
                type="text"
                value={consoleInput}
                onChange={(e) => setConsoleInput(e.target.value)}
                placeholder="Type G-code command (e.g. G0 X10 Y10)..."
                disabled={!status.connected}
                className="flex-1 px-3 py-1.5 bg-slate-800 border border-slate-700 rounded text-slate-100 text-xs font-mono focus:outline-none focus:border-amber-500"
              />
              <button
                type="submit"
                disabled={!status.connected}
                className="px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-white font-bold text-xs rounded cursor-pointer"
              >
                Send
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};
