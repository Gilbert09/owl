import React, { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

interface XTermProps {
  /** Terminal output to display */
  output: string;
  /** Called when user types input */
  onInput?: (data: string) => void;
  /** Whether input is enabled */
  inputEnabled?: boolean;
  /** Terminal theme */
  theme?: 'dark' | 'light';
  /** Custom class name */
  className?: string;
}

const darkTheme = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  cursorAccent: '#1e1e1e',
  black: '#1e1e1e',
  red: '#f44747',
  green: '#6a9955',
  yellow: '#dcdcaa',
  blue: '#569cd6',
  magenta: '#c586c0',
  cyan: '#4ec9b0',
  white: '#d4d4d4',
  brightBlack: '#808080',
  brightRed: '#f44747',
  brightGreen: '#6a9955',
  brightYellow: '#dcdcaa',
  brightBlue: '#569cd6',
  brightMagenta: '#c586c0',
  brightCyan: '#4ec9b0',
  brightWhite: '#ffffff',
  selectionBackground: '#264f78',
};

export function XTerm({
  output,
  onInput,
  inputEnabled = false,
  theme = 'dark',
  className = '',
}: XTermProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastOutputRef = useRef<string>('');

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      theme: theme === 'dark' ? darkTheme : undefined,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: inputEnabled,
      cursorStyle: inputEnabled ? 'bar' : 'underline',
      disableStdin: !inputEnabled,
      scrollback: 5000,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);

    terminal.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        // Ignore errors when element is not visible
      }
    });
    resizeObserver.observe(containerRef.current);

    // Handle input
    if (onInput && inputEnabled) {
      terminal.onData((data) => {
        onInput(data);
      });
    }

    return () => {
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [theme, inputEnabled, onInput]);

  // Update output
  useEffect(() => {
    if (!terminalRef.current) return;

    const terminal = terminalRef.current;
    const newOutput = output || '';
    const lastOutput = lastOutputRef.current;

    // If output changed, check if it's an append or a full replacement
    if (newOutput !== lastOutput) {
      if (newOutput.startsWith(lastOutput) && lastOutput.length > 0) {
        // Append new content
        const newContent = newOutput.slice(lastOutput.length);
        terminal.write(newContent);
      } else {
        // Full replacement
        terminal.clear();
        terminal.write(newOutput);
      }
      lastOutputRef.current = newOutput;
    }
  }, [output]);

  // Handle fit on visibility change
  const handleFit = useCallback(() => {
    if (fitAddonRef.current) {
      try {
        fitAddonRef.current.fit();
      } catch {
        // Ignore
      }
    }
  }, []);

  // Fit when component becomes visible
  useEffect(() => {
    const handle = setTimeout(handleFit, 100);
    return () => clearTimeout(handle);
  }, [handleFit]);

  return (
    <div
      ref={containerRef}
      className={`h-full w-full ${className}`}
      style={{ padding: '8px' }}
    />
  );
}
