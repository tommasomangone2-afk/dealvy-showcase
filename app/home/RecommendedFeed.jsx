'use client';

/**
 * app/home/RecommendedFeed.jsx  (extracted from app/page.js)
 *
 * The UI for Dealvy's social differentiator: "Recommended by people you follow".
 * Each card is a recommendation — a product plus who recommended it and why —
 * which is the atomic unit the whole social layer is built on.
 *
 * In the live app this markup lives inline in the home page component; here it is a
 * self-contained presentational component. It receives its data and callbacks as
 * props (the data comes from useHomeFeeds -> socialFeed) and owns no fetching logic.
 *
 * Icon components (IconHeart, IconBell, ...) are small inline SVGs imported from a
 * shared module; omitted here for brevity.
 */

import { useRef, useState } from 'react';
import { IconHeart, IconBell, IconList, IconChart, IconSend } from './icons';

// Relative "time ago" label, e.g. "3h", "2d". Kept compact for the card header.
function timeAgo(iso) {
  if (!iso) return '';
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

// Round avatar with a coloured initial fallback when the image is missing or fails.
function Avatar({ size = 28, avatarUrl, username = '' }) {
  const [failed, setFailed] = useState(false);
  const initial = (username || '?').charAt(0).toUpperCase();
  if (avatarUrl && !failed) {
    return (
      <img
        src={avatarUrl}
        alt={username}
        width={size}
        height={size}
        onError={() => setFailed(true)}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
      />
    );
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      background: '#0B3954', color: '#00E676', display: 'flex',
      alignItems: 'center', justifyContent: 'center', fontWeight: 800,
      fontSize: size * 0.42,
    }}>
      {initial}
    </div>
  );
}

/**
 * @param {Array}    recommendations  items from useHomeFeeds().socialFeed
 * @param {boolean}  loading
 * @param {object}   savedLinks       map of product link -> already-saved boolean
 * @param {function} onSave           (product) => void
 * @param {function} onAlert          (product) => void
 * @param {function} onSharedList     (product) => void
 * @param {function} onSend           (product) => void  (share with another user)
 */
export default function RecommendedFeed({
  recommendations = [],
  loading = false,
  savedLinks = {},
  onSave,
  onAlert,
  onSharedList,
  onSend,
}) {
  const scrollRef = useRef(null);
  const scrollBy = (delta) => scrollRef.current?.scrollBy({ left: delta, behavior: 'smooth' });

  // Reserve height even while loading/empty so the section never causes layout shift.
  const reserveHeight = loading || recommendations.length > 0 ? 260 : 0;

  return (
    <section style={{ marginTop: '2.25rem', marginBottom: '0.5rem', minHeight: reserveHeight }}>
      <style>{`
        .rf-wrap{display:flex;gap:0.75rem;overflow-x:auto;padding-bottom:0.5rem;scrollbar-width:none;-ms-overflow-style:none;}
        .rf-wrap::-webkit-scrollbar{display:none;}
        .rf-card{flex-shrink:0;width:230px;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e9edf2;box-shadow:0 1px 2px rgba(11,57,84,0.04);display:flex;flex-direction:column;}
        .rf-head{display:flex;align-items:center;gap:0.5rem;padding:0.6rem 0.7rem 0.4rem;text-decoration:none;}
        .rf-username{font-size:0.78rem;font-weight:700;color:#0B3954;}
        .rf-time{font-size:0.66rem;color:#9aa5b0;}
        .rf-msg{font-size:0.74rem;color:#5a6a75;font-style:italic;line-height:1.4;padding:0 0.7rem 0.55rem;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;}
        .rf-prod{display:flex;align-items:center;gap:0.55rem;background:#f7f9fb;margin:0 0.6rem 0.6rem;padding:0.5rem;border-radius:10px;text-decoration:none;}
        .rf-prod-img{width:44px;height:44px;flex-shrink:0;background:#eef1f5;border-radius:8px;display:flex;align-items:center;justify-content:center;overflow:hidden;}
        .rf-prod-img img{width:100%;height:100%;object-fit:contain;}
        .rf-prod-info{flex:1;min-width:0;}
        .rf-prod-title{font-size:0.7rem;color:#5a6a75;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}
        .rf-prod-price{font-size:0.85rem;font-weight:800;color:#00a855;font-family:'Montserrat',sans-serif;}
        .rf-foot{display:flex;align-items:stretch;border-top:1px solid #eef1f5;}
        .rf-btn{background:none;border:none;cursor:pointer;padding:0.5rem;flex:1;display:flex;align-items:center;justify-content:center;}
        .rf-btn:hover{background:#f0f4f8;}
        .rf-send{background:#0B3954;border:none;cursor:pointer;padding:0.5rem;flex:1.3;display:flex;align-items:center;justify-content:center;gap:0.3rem;font-size:0.68rem;font-weight:700;color:#00E676;}
        .rf-send:hover{background:#0d4a6b;}
        .rf-skel{flex-shrink:0;width:230px;height:230px;background:#f0f2f5;border-radius:16px;animation:rfPulse 1.5s ease-in-out infinite;}
        @keyframes rfPulse{0%,100%{opacity:1;}50%{opacity:0.5;}}
        @media(max-width:640px){.rf-card{width:210px;}}
      `}</style>

      {(loading || recommendations.length > 0) && (
        <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '0.7rem', padding: '0 0.15rem' }}>
          <span style={{ fontFamily: "'Montserrat', sans-serif", fontSize: '1.05rem', fontWeight: 800, color: '#0B3954' }}>
            Recommended by people you follow
          </span>
          <a href="/social" style={{ fontSize: '0.72rem', color: '#0B3954', fontWeight: 700, textDecoration: 'none' }}>
            See all
          </a>
        </header>
      )}

      {loading ? (
        <div className="rf-wrap">{[1, 2, 3].map(i => <div key={i} className="rf-skel" />)}</div>
      ) : recommendations.length > 0 ? (
        <div style={{ position: 'relative' }}>
          <div className="rf-wrap" ref={scrollRef}>
            {recommendations.map((rec) => {
              const product = {
                title: rec.title, price: rec.price, image: rec.image,
                link: rec.link, source: rec.source, condition: 'New',
              };
              const username = rec._profile?.username || 'Dealvy';
              const profileUrl = rec._profile?.username ? `/u/${encodeURIComponent(username)}` : null;
              const HeadTag = profileUrl ? 'a' : 'div';

              return (
                <article key={rec.id} className="rf-card">
                  {/* Who recommended it */}
                  <HeadTag className="rf-head" {...(profileUrl ? { href: profileUrl } : {})}>
                    <Avatar size={28} avatarUrl={rec._profile?.avatar_url} username={username} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="rf-username">@{username}</div>
                      <div className="rf-time">recommends · {timeAgo(rec.created_at)}</div>
                    </div>
                  </HeadTag>

                  {/* Why (the free-text reason is required on every recommendation) */}
                  {rec.message && <div className="rf-msg">&quot;{rec.message}&quot;</div>}

                  {/* What */}
                  <a href={rec.link} target="_blank" rel="noopener noreferrer" className="rf-prod">
                    <div className="rf-prod-img">
                      {rec.image
                        ? <img src={rec.image} alt={rec.title} loading="lazy" />
                        : null}
                    </div>
                    <div className="rf-prod-info">
                      <div className="rf-prod-title">{rec.title}</div>
                      <div className="rf-prod-price">{rec.price}</div>
                    </div>
                  </a>

                  {/* Actions */}
                  <div className="rf-foot">
                    <button className="rf-btn" onClick={() => onSave?.(product)} aria-label="Save to wishlist">
                      <IconHeart filled={savedLinks[rec.link]} />
                    </button>
                    <button className="rf-btn" onClick={() => onAlert?.(product)} aria-label="Set price alert">
                      <IconBell />
                    </button>
                    <button className="rf-btn" onClick={() => onSharedList?.(product)} aria-label="Add to a shared list">
                      <IconList />
                    </button>
                    <a
                      className="rf-btn"
                      href={`/price-history?link=${encodeURIComponent(rec.link)}&title=${encodeURIComponent(rec.title)}`}
                      aria-label="Price history"
                    >
                      <IconChart />
                    </a>
                    <button className="rf-send" onClick={() => onSend?.(product)}>
                      <IconSend size={13} color="#00E676" /> Send
                    </button>
                  </div>
                </article>
              );
            })}
          </div>

          {/* Desktop scroll arrows */}
          <button
            onClick={() => scrollBy(-480)}
            aria-label="Scroll left"
            style={arrowStyle('left')}
          >
            ‹
          </button>
          <button
            onClick={() => scrollBy(480)}
            aria-label="Scroll right"
            style={arrowStyle('right')}
          >
            ›
          </button>
        </div>
      ) : null}
    </section>
  );
}

function arrowStyle(side) {
  return {
    position: 'absolute', top: '50%', [side]: '-6px', transform: 'translateY(-50%)',
    width: 32, height: 32, borderRadius: '50%', border: '1px solid #e9edf2',
    background: '#fff', color: '#0B3954', cursor: 'pointer', fontSize: '1.1rem',
    boxShadow: '0 2px 8px rgba(11,57,84,0.12)', display: 'flex',
    alignItems: 'center', justifyContent: 'center',
  };
}
