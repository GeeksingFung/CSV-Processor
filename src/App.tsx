import React, { useState, useCallback, useEffect } from 'react';
import Papa from 'papaparse';
import { UploadCloud, FolderOpen, CheckSquare, Square, Copy, Info, Languages, Loader2 } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { GoogleGenAI, Type } from '@google/genai';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function App() {
  const [csvData, setCsvData] = useState<string[][]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [dirHandle, setDirHandle] = useState<any>(null);
  const [checkedRows, setCheckedRows] = useState<Set<number>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [isInIframe, setIsInIframe] = useState(false);
  const [encoding, setEncoding] = useState<string>('GBK');
  const [currentFile, setCurrentFile] = useState<File | null>(null);
  const [filters, setFilters] = useState<Record<number, string>>({});
  const [translatedCols, setTranslatedCols] = useState<Set<number>>(new Set());
  const [translations, setTranslations] = useState<Record<number, Record<string, string>>>({});
  const [isTranslating, setIsTranslating] = useState<Record<number, boolean>>({});

  useEffect(() => {
    try {
      setIsInIframe(window.self !== window.top);
    } catch (e) {
      setIsInIframe(true);
    }
  }, []);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const handleCsvDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith('.csv')) {
      setCurrentFile(file);
    } else {
      showToast('Please drop a valid CSV file.');
    }
  }, []);

  useEffect(() => {
    if (!currentFile) return;
    
    Papa.parse(currentFile, {
      encoding: encoding,
      complete: (results) => {
        const data = results.data as string[][];
        if (data.length < 1) return;

        const rawHeaders = data[0];
        const allRows = data.slice(1);

        setHeaders([
          rawHeaders[0] || 'A', 
          rawHeaders[1] || 'B', 
          rawHeaders[3] || 'D', 
          rawHeaders[4] || 'E',
          rawHeaders[6] || 'G'
        ]);
        setCsvData(allRows.map(row => [
          row[0] || '', 
          row[1] || '', 
          row[3] || '', 
          row[4] || '',
          row[6] || ''
        ]));
        setFilters({});
        setCheckedRows(new Set());
        setTranslatedCols(new Set());
        setTranslations({});
        setIsTranslating({});
      }
    });
  }, [currentFile, encoding]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const selectDirectory = async () => {
    try {
      if (!('showDirectoryPicker' in window)) {
        showToast('Your browser does not support the File System Access API. Files will be downloaded instead.');
        return;
      }
      const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
      setDirHandle(handle);
      showToast(`Selected directory: ${handle.name}`);
    } catch (err: any) {
      console.error(err);
      if (err.name === 'SecurityError' || err.message?.includes('Cross origin') || err.message?.includes('iframe')) {
        showToast('Cannot open directory picker in an iframe. Please open the app in a new tab.');
      } else if (err.name !== 'AbortError') {
        showToast('Failed to select directory.');
      }
    }
  };

  const toggleRow = (index: number) => {
    const newChecked = new Set(checkedRows);
    if (newChecked.has(index)) {
      newChecked.delete(index);
    } else {
      newChecked.add(index);
    }
    setCheckedRows(newChecked);
  };

  const handleCellClick = (value: string) => {
    if (value === undefined || value === null) return;
    navigator.clipboard.writeText(value);
    showToast(`Copied: ${value}`);
  };

  const handleFileDropOnCell = async (e: React.DragEvent, newNameBase: string) => {
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer.files[0];
    if (!file) return;

    const ext = file.name.split('.').pop();
    // 提取主表格C列数据中“.”之前的内容（去除原有的扩展名）
    const lastDotIndex = newNameBase.lastIndexOf('.');
    const baseName = lastDotIndex !== -1 ? newNameBase.substring(0, lastDotIndex) : newNameBase;
    const newName = `${baseName}.${ext}`;

    if (dirHandle) {
      try {
        const fileHandle = await dirHandle.getFileHandle(newName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(file);
        await writable.close();
        showToast(`Saved as ${newName} in ${dirHandle.name}`);
        return;
      } catch (err) {
        console.error('File System Access API failed', err);
        showToast('Failed to save directly. Downloading instead...');
      }
    }

    // Fallback
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = newName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Downloaded as ${newName}`);
  };

  const getUniqueValues = (colIndex: number): string[] => {
    const vals = new Set(csvData.map(row => row[colIndex]));
    return Array.from(vals).filter((val): val is string => Boolean(val)).sort();
  };

  const filteredData = csvData.filter(row => {
    return Object.entries(filters).every(([colIdx, filterVal]) => {
      if (!filterVal) return true;
      return row[Number(colIdx)] === filterVal;
    });
  });

  const toggleTranslation = async (colIndex: number) => {
    if (translatedCols.has(colIndex)) {
      const newSet = new Set(translatedCols);
      newSet.delete(colIndex);
      setTranslatedCols(newSet);
      return;
    }

    if (translations[colIndex]) {
      const newSet = new Set(translatedCols);
      newSet.add(colIndex);
      setTranslatedCols(newSet);
      return;
    }

    setIsTranslating(prev => ({ ...prev, [colIndex]: true }));
    try {
      const uniqueValues = getUniqueValues(colIndex);
      if (uniqueValues.length === 0) {
        setIsTranslating(prev => ({ ...prev, [colIndex]: false }));
        return;
      }

      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const prompt = `Translate the following JSON array of strings. If a string is mostly Chinese, translate it to English. If it is mostly English, translate it to Chinese. Keep the exact same array length and order. Return a JSON object with a single key "translations" containing the array of translated strings.`;

      const chunkSize = 50;
      let allTranslated: string[] = [];

      for (let i = 0; i < uniqueValues.length; i += chunkSize) {
        const chunk = uniqueValues.slice(i, i + chunkSize);
        
        const response = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: `${prompt}\n\n${JSON.stringify(chunk)}`,
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                translations: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING }
                }
              },
              required: ["translations"]
            }
          }
        });

        let responseText = response.text || '{}';
        responseText = responseText.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
        
        const parsed = JSON.parse(responseText);
        const translatedChunk = parsed.translations || [];
        
        if (!Array.isArray(translatedChunk) || translatedChunk.length !== chunk.length) {
          throw new Error(`Invalid translation response length for chunk ${i / chunkSize}`);
        }
        
        allTranslated = allTranslated.concat(translatedChunk);
      }
      
      const newTranslationMap: Record<string, string> = {};
      uniqueValues.forEach((val, idx) => {
        newTranslationMap[val] = allTranslated[idx] || val;
      });

      setTranslations(prev => ({ ...prev, [colIndex]: newTranslationMap }));
      
      const newSet = new Set(translatedCols);
      newSet.add(colIndex);
      setTranslatedCols(newSet);
      showToast(`Column translated successfully.`);
    } catch (error: any) {
      console.error("Translation error:", error);
      showToast(`Translation failed: ${error?.message || 'Unknown error'}`);
    } finally {
      setIsTranslating(prev => ({ ...prev, [colIndex]: false }));
    }
  };

  const getDisplayValue = (val: string, colIdx: number) => {
    if (translatedCols.has(colIdx) && translations[colIdx]) {
      return translations[colIdx][val] || val;
    }
    return val;
  };

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 font-sans p-8">
      {/* Header */}
      <div className="max-w-7xl mx-auto mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">CSV Grok Processor</h1>
          <p className="text-neutral-500 mt-1">Process CSV files and manage file renaming via drag-and-drop.</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-neutral-600">编码 (Encoding):</label>
            <select
              value={encoding}
              onChange={(e) => setEncoding(e.target.value)}
              className="px-3 py-2 bg-white border border-neutral-200 rounded-xl shadow-sm text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="GBK">GBK (中文 Excel 默认)</option>
              <option value="UTF-8">UTF-8</option>
            </select>
          </div>
          {isInIframe ? (
            <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 border border-amber-200 text-amber-700 rounded-xl shadow-sm text-sm max-w-md">
              <Info className="w-5 h-5 shrink-0" />
              <span>Open app in a new tab to select a save directory. (Downloads are used as a fallback here)</span>
            </div>
          ) : (
            <button
              onClick={selectDirectory}
              className="flex items-center gap-2 px-4 py-2 bg-white border border-neutral-200 rounded-xl shadow-sm hover:bg-neutral-50 transition-colors font-medium text-sm"
            >
              <FolderOpen className="w-4 h-4 text-neutral-500" />
              {dirHandle ? `Save to: ${dirHandle.name}` : 'Select Save Directory'}
            </button>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto">
        {csvData.length === 0 ? (
          <div
            onDrop={handleCsvDrop}
            onDragOver={handleDragOver}
            className="border-2 border-dashed border-neutral-300 rounded-2xl bg-white p-16 flex flex-col items-center justify-center text-center transition-colors hover:border-blue-400 hover:bg-blue-50/50 cursor-pointer"
          >
            <div className="w-16 h-16 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mb-4">
              <UploadCloud className="w-8 h-8" />
            </div>
            <h2 className="text-xl font-medium mb-2">Drag & Drop CSV File</h2>
            <p className="text-neutral-500 max-w-md">
              Drop your CSV file here. The app will filter rows where column E is "Grok" and extract columns A, B, D, and G.
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl shadow-sm border border-neutral-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-neutral-50 border-b border-neutral-200 text-neutral-600 font-medium">
                  <tr>
                    <th className="px-4 py-3 w-12 text-center"></th>
                    {headers.map((header, idx) => (
                      <th key={idx} className="px-4 py-3 align-top">
                        <div className="flex flex-col gap-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-neutral-700">{header} <span className="text-neutral-400 font-normal text-xs">(原 {['A', 'B', 'D', 'E', 'G'][idx]} 列)</span></span>
                            <button
                              onClick={() => toggleTranslation(idx)}
                              disabled={isTranslating[idx]}
                              className={cn(
                                "p-1.5 rounded-md transition-colors",
                                translatedCols.has(idx) ? "bg-blue-100 text-blue-600" : "text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700",
                                isTranslating[idx] && "opacity-50 cursor-not-allowed"
                              )}
                              title="Toggle Translation (ZH ↔ EN)"
                            >
                              {isTranslating[idx] ? <Loader2 className="w-4 h-4 animate-spin" /> : <Languages className="w-4 h-4" />}
                            </button>
                          </div>
                          <select
                            className="text-xs border border-neutral-300 rounded px-1 py-1 font-normal bg-white text-neutral-700 focus:outline-none focus:ring-1 focus:ring-blue-500 max-w-[150px]"
                            value={filters[idx] || ''}
                            onChange={(e) => setFilters(prev => ({ ...prev, [idx]: e.target.value }))}
                          >
                            <option value="">全部 (All)</option>
                            {getUniqueValues(idx).map(val => (
                              <option key={val} value={val}>{getDisplayValue(val, idx)}</option>
                            ))}
                          </select>
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {filteredData.map((row) => {
                    const originalIndex = csvData.indexOf(row);
                    const isChecked = checkedRows.has(originalIndex);
                    return (
                      <tr
                        key={originalIndex}
                        className={cn(
                          "transition-colors hover:bg-neutral-50/50",
                          isChecked && "bg-neutral-50 text-neutral-400 line-through"
                        )}
                      >
                        <td className="px-4 py-3 text-center">
                          <button
                            onClick={() => toggleRow(originalIndex)}
                            className="text-neutral-400 hover:text-blue-600 transition-colors focus:outline-none"
                          >
                            {isChecked ? <CheckSquare className="w-5 h-5 text-blue-600" /> : <Square className="w-5 h-5" />}
                          </button>
                        </td>
                        <TableCell value={getDisplayValue(row[0], 0)} onClick={() => handleCellClick(getDisplayValue(row[0], 0))} />
                        <TableCell value={getDisplayValue(row[1], 1)} onClick={() => handleCellClick(getDisplayValue(row[1], 1))} />
                        <TableCell
                          value={getDisplayValue(row[2], 2)}
                          onClick={() => handleCellClick(getDisplayValue(row[2], 2))}
                          isDropTarget
                          onDropFile={(e) => handleFileDropOnCell(e, getDisplayValue(row[2], 2))}
                        />
                        <TableCell value={getDisplayValue(row[3], 3)} onClick={() => handleCellClick(getDisplayValue(row[3], 3))} />
                        <TableCell value={getDisplayValue(row[4], 4)} onClick={() => handleCellClick(getDisplayValue(row[4], 4))} />
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-8 right-8 bg-neutral-900 text-white px-6 py-3 rounded-xl shadow-lg flex items-center gap-3 animate-in fade-in slide-in-from-bottom-4 z-50">
          <Info className="w-5 h-5 text-blue-400" />
          <span className="font-medium text-sm">{toast}</span>
        </div>
      )}
    </div>
  );
}

interface TableCellProps {
  value: string;
  onClick: () => void;
  isDropTarget?: boolean;
  onDropFile?: (e: React.DragEvent) => void;
}

function TableCell({ value, onClick, isDropTarget, onDropFile }: TableCellProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    if (!isDropTarget) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!isDropTarget) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    if (!isDropTarget) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    if (onDropFile) {
      onDropFile(e);
    }
  };

  return (
    <td
      className={cn(
        "px-4 py-3 cursor-pointer transition-all duration-200 relative",
        (isHovered || isDragOver) && "bg-blue-50/80 text-blue-900 font-medium",
        isDragOver && "ring-2 ring-inset ring-blue-500 bg-blue-100"
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={onClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      title={isDropTarget ? "Click to copy, or drop a file here to rename and save" : "Click to copy"}
    >
      {value}
      {isHovered && !isDragOver && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2 text-blue-500 opacity-50">
          <Copy className="w-4 h-4" />
        </div>
      )}
    </td>
  );
}
