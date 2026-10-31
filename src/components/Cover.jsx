import React, { useState, useEffect } from 'react';
import Icon from './Icon';
import { coverUrl } from '../utils/audio';

// Album art from the media:// protocol, falling back to a placeholder when the file has none
const Cover = ({ file, src, className = '', style, alt = '' }) => {
  const url = src ?? coverUrl(file);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url, file?.cache_path]);

  return (
    <div className={`cover ${className}`} style={style}>
      {url && !failed ? (
        <img src={url} alt={alt} loading="lazy" draggable={false} onError={() => setFailed(true)} />
      ) : (
        <div className="cover-fallback"><Icon name="music" /></div>
      )}
    </div>
  );
};

export default Cover;
