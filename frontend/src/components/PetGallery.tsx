// Pet Gallery: browse and one-click install pet skins from the petdex.dev
// registry, and manage locally installed skins (equip, queue, favorite, delete,
// details).
//
// Market data: the full petdex manifest (GET https://petdex.dev/api/manifest)
// is fetched once through the Rust `fetch_petdex_manifest` command; search,
// kind filter and pagination all run client-side. Downloads go through
// `download_codex_pet` with the manifest's zipUrl (Rust validates the
// assets.petdex.dev prefix); local skins are served by the codexpet://
// protocol. A per-card error boundary keeps one broken/odd-atlas skin from
// taking down the whole grid section.
import { Component, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Info, Loader2, Search, Star, Trash2, X } from 'lucide-react'
import { SpritePet } from './SpritePet'
import {
  type CodexPet,
  type PetdexPet,
  downloadMarketPet,
  deleteLocalPet,
  loadCustomCodexPets,
  loadPetdexManifest,
} from '../lib/codexPet'
import { loadPetFavorites, savePetFavorites } from '../lib/petStore'

interface PetGalleryProps {
  miniPetId: string | null
  onEquip: (pet: CodexPet) => void
  onAddToQueue: (id: string) => void
}

const MARKET_PAGE_SIZE = 60

type KindFilter = 'all' | 'creature' | 'character' | 'object'

const KIND_LABEL_KEYS: Record<'creature' | 'character' | 'object', string> = {
  creature: 'petGallery.kindCreature',
  character: 'petGallery.kindCharacter',
  object: 'petGallery.kindObject',
}

function petdexPetToCodexPet(p: PetdexPet): CodexPet {
  return {
    id: p.slug,
    displayName: p.displayName,
    // The petdex manifest has no description field.
    description: '',
    spritesheetUrl: p.spritesheetUrl,
  }
}

// Error boundary around each SpritePet preview so a single broken skin
// degrades to a placeholder instead of crashing the whole section (R1).
class SpritePreview extends Component<{ pet: CodexPet; size: number }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(err: unknown): void {
    console.warn('[PetGallery] sprite preview failed for', this.props.pet.id, err)
  }

  componentDidUpdate(prev: { pet: CodexPet }): void {
    if (prev.pet.id !== this.props.pet.id && this.state.failed) {
      this.setState({ failed: false })
    }
  }

  render() {
    if (this.state.failed) {
      return (
        <div
          style={{
            width: this.props.size,
            height: Math.round(this.props.size * (208 / 192)),
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 26,
            color: 'rgba(255,255,255,0.3)',
            background: 'rgba(255,255,255,0.03)',
            borderRadius: 8,
          }}
        >
          🖼️
        </div>
      )
    }
    return <SpritePet pet={this.props.pet} state="idle" size={this.props.size} />
  }
}

interface LocalSource {
  author_name?: string
  license?: string
  tags?: string[]
}

type DetailItem =
  | { kind: 'market'; pet: PetdexPet }
  | { kind: 'local'; pet: CodexPet; source: LocalSource | null }

export function PetGallery({ miniPetId, onEquip, onAddToQueue }: PetGalleryProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'market' | 'skins'>('market')

  // Market state
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [kind, setKind] = useState<KindFilter>('all')
  const [marketPets, setMarketPets] = useState<PetdexPet[]>([])
  const [visibleCount, setVisibleCount] = useState(MARKET_PAGE_SIZE)
  const [marketLoading, setMarketLoading] = useState(false)
  const [marketError, setMarketError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState<Set<string>>(new Set())

  // Local skins + favorites
  const [customs, setCustoms] = useState<CodexPet[]>([])
  const [favorites, setFavorites] = useState<string[]>([])
  const [detail, setDetail] = useState<DetailItem | null>(null)
  const [localSources, setLocalSources] = useState<Record<string, LocalSource | null>>({})

  const refreshCustoms = useCallback(async () => {
    setCustoms(await loadCustomCodexPets())
  }, [])

  const refreshFavorites = useCallback(async () => {
    setFavorites(await loadPetFavorites())
  }, [])

  useEffect(() => {
    void refreshCustoms()
    void refreshFavorites()
  }, [refreshCustoms, refreshFavorites])

  // Fetch the petdex manifest once on mount; search/filter/pagination all
  // happen client-side over the cached array afterwards.
  useEffect(() => {
    let cancelled = false
    setMarketLoading(true)
    setMarketError(null)
    loadPetdexManifest()
      .then((pets) => {
        if (!cancelled) setMarketPets(pets)
      })
      .catch((e) => {
        if (!cancelled) setMarketError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setMarketLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Debounced (400ms) client-side search query.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), 400)
    return () => clearTimeout(timer)
  }, [q])

  // Restart at the top of the list whenever the query or kind filter changes.
  useEffect(() => {
    setVisibleCount(MARKET_PAGE_SIZE)
  }, [debouncedQ, kind])

  const loadMore = useCallback(() => {
    setVisibleCount((c) => c + MARKET_PAGE_SIZE)
  }, [])

  const toggleFavorite = useCallback(async (id: string) => {
    setFavorites((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      void savePetFavorites(next)
      return next
    })
  }, [])

  const handleDownload = useCallback(
    async (slug: string, zipUrl: string) => {
      setDownloading((prev) => new Set(prev).add(slug))
      try {
        await downloadMarketPet(slug, zipUrl)
        await refreshCustoms()
      } catch (e) {
        console.warn('[PetGallery] download failed:', e)
        setMarketError(t('petGallery.downloadFailed') + (e instanceof Error ? `: ${e.message}` : ''))
      } finally {
        setDownloading((prev) => {
          const next = new Set(prev)
          next.delete(slug)
          return next
        })
      }
    },
    [refreshCustoms, t],
  )

  const handleDelete = useCallback(
    async (id: string) => {
      if (!window.confirm(t('petGallery.deleteConfirm', { name: id }))) return
      try {
        await deleteLocalPet(id)
        await refreshCustoms()
      } catch (e) {
        console.warn('[PetGallery] delete failed:', e)
        window.alert(e instanceof Error ? e.message : String(e))
      }
    },
    [refreshCustoms, t],
  )

  const openLocalDetail = useCallback(
    async (pet: CodexPet) => {
      setDetail({ kind: 'local', pet, source: localSources[pet.id] ?? null })
      if (localSources[pet.id] !== undefined) return
      let source: LocalSource | null = null
      try {
        // source.json lives next to the spritesheet in ~/.codex/pets/<id> and
        // is served by the same codexpet:// protocol; derive its URL from the
        // spritesheet URL so we don't need a new command.
        const srcUrl = pet.spritesheetUrl.replace(/\/[^/]*$/, '/source.json')
        const res = await fetch(srcUrl)
        if (res.ok) source = (await res.json()) as LocalSource
      } catch {
        source = null
      }
      setLocalSources((prev) => ({ ...prev, [pet.id]: source }))
      setDetail({ kind: 'local', pet, source })
    },
    [localSources],
  )

  const installedIds = useMemo(() => new Set(customs.map((c) => c.id)), [customs])
  const favSet = useMemo(() => new Set(favorites), [favorites])

  // Client-side search (substring, case-insensitive, over displayName/slug/
  // submittedBy) + kind filter, ordered by displayName (locale-aware).
  const filteredPets = useMemo(() => {
    const needle = debouncedQ.trim().toLowerCase()
    const byKind = kind === 'all' ? marketPets : marketPets.filter((p) => p.kind === kind)
    const matched = needle
      ? byKind.filter(
          (p) =>
            p.displayName.toLowerCase().includes(needle) ||
            p.slug.toLowerCase().includes(needle) ||
            p.submittedBy.toLowerCase().includes(needle),
        )
      : byKind
    return [...matched].sort((a, b) => a.displayName.localeCompare(b.displayName))
  }, [marketPets, debouncedQ, kind])

  const visiblePets = useMemo(() => filteredPets.slice(0, visibleCount), [filteredPets, visibleCount])
  const hasMore = visiblePets.length < filteredPets.length

  const tabBtnStyle = (active: boolean): React.CSSProperties => ({
    background: active ? 'rgba(255,255,255,0.12)' : 'none',
    border: 'none',
    color: active ? '#fff' : 'rgba(255,255,255,0.45)',
    fontSize: 12,
    cursor: 'pointer',
    padding: '5px 14px',
    borderRadius: 8,
    fontWeight: active ? 600 : 400,
  })

  const actionBtnStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    border: '1px solid rgba(255,255,255,0.15)',
    background: 'none',
    color: 'rgba(255,255,255,0.85)',
    fontSize: 11,
    cursor: 'pointer',
    padding: '3px 8px',
    borderRadius: 6,
  }

  return (
    <div className="h-full flex flex-col bg-[#151515] text-white font-sans antialiased">
      {/* Tab switcher */}
      <div className="flex items-center gap-1 px-4 pt-3 pb-2 border-b border-white/5">
        <button style={tabBtnStyle(tab === 'market')} onClick={() => setTab('market')}>
          {t('petGallery.market')}
        </button>
        <button style={tabBtnStyle(tab === 'skins')} onClick={() => setTab('skins')}>
          {t('petGallery.mySkins')}
        </button>
        <span className="ml-auto text-[11px] text-white/35">
          {t('petGallery.installed')} {customs.length}
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hidden p-4">
        {tab === 'market' && (
          <div>
            {/* Toolbar: search + sort */}
            <div className="flex items-center gap-2 mb-3">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/35" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={t('petGallery.searchPlaceholder')}
                  className="w-full bg-white/5 border border-white/10 rounded-lg pl-8 pr-3 py-1.5 text-xs outline-none focus:border-white/25 placeholder:text-white/30"
                />
              </div>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as KindFilter)}
                className="bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs outline-none text-white/85 cursor-pointer"
              >
                <option value="all">{t('petGallery.kindAll')}</option>
                <option value="creature">{t('petGallery.kindCreature')}</option>
                <option value="character">{t('petGallery.kindCharacter')}</option>
                <option value="object">{t('petGallery.kindObject')}</option>
              </select>
            </div>

            {marketError && (
              <div className="text-[11px] text-rose-400 mb-3 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
                {marketError}
              </div>
            )}

            {marketLoading && marketPets.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-10 text-white/40">
                <Loader2 className="w-5 h-5 animate-spin" />
                <p className="text-[11px]">{t('common.loading')}</p>
              </div>
            )}

            {/* Market grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {visiblePets.map((p) => {
                const installed = installedIds.has(p.slug)
                const isDownloading = downloading.has(p.slug)
                const fav = favSet.has(p.slug)
                const codexPet = petdexPetToCodexPet(p)
                return (
                  <div
                    key={p.slug}
                    className="bg-white/[0.03] border border-white/10 rounded-xl p-3 flex flex-col gap-2"
                  >
                    <div className="flex justify-center">
                      {/* Dark plate hugs the 64px sprite instead of stretching
                          full card width — full-width plates looked disjointed. */}
                      <div className="bg-black/20 rounded-lg py-2 px-3">
                        <SpritePreview pet={codexPet} size={64} />
                      </div>
                    </div>
                    <div className="min-h-0">
                      <p className="text-xs font-medium truncate" title={p.displayName}>
                        {p.displayName || p.slug}
                      </p>
                      <p className="text-[10px] text-white/40 truncate">{t(KIND_LABEL_KEYS[p.kind])}</p>
                      <p className="text-[10px] text-white/35 mt-0.5">
                        {p.submittedBy ? `${t('petGallery.author')}: ${p.submittedBy}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 mt-auto">
                      {isDownloading ? (
                        <span style={actionBtnStyle} className="opacity-60">
                          <Loader2 className="w-3 h-3 animate-spin" /> {t('petGallery.downloading')}
                        </span>
                      ) : installed ? (
                        <span style={actionBtnStyle} className="opacity-50 cursor-default">
                          {t('petGallery.installed')}
                        </span>
                      ) : (
                        <button
                          style={actionBtnStyle}
                          onClick={() => void handleDownload(p.slug, p.zipUrl)}
                          className="hover:bg-white/10"
                        >
                          <Download className="w-3 h-3" /> {t('petGallery.download')}
                        </button>
                      )}
                      <button
                        style={actionBtnStyle}
                        onClick={() => void toggleFavorite(p.slug)}
                        title={t('petGallery.favorite')}
                        className="hover:bg-white/10"
                      >
                        <Star
                          className="w-3 h-3"
                          fill={fav ? '#fbbf24' : 'none'}
                          color={fav ? '#fbbf24' : 'rgba(255,255,255,0.6)'}
                        />
                      </button>
                      <button
                        style={actionBtnStyle}
                        onClick={() => setDetail({ kind: 'market', pet: p })}
                        title={t('petGallery.details')}
                        className="hover:bg-white/10 ml-auto"
                      >
                        <Info className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>

            {filteredPets.length === 0 && !marketLoading && !marketError && (
              <p className="text-center text-xs text-white/35 py-10">—</p>
            )}

            {/* Load more */}
            <div className="flex justify-center mt-4">
              {hasMore ? (
                <button
                  onClick={() => void loadMore()}
                  className="text-xs text-white/70 border border-white/15 rounded-lg px-4 py-1.5 hover:bg-white/10"
                >
                  {t('petGallery.loadMore')}
                </button>
              ) : null}
            </div>
          </div>
        )}

        {tab === 'skins' && (
          <div>
            {customs.length === 0 ? (
              <p className="text-center text-xs text-white/35 py-10">—</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {customs.map((pet) => {
                  const fav = favSet.has(pet.id)
                  const equipped = miniPetId === pet.id
                  return (
                    <div
                      key={pet.id}
                      className="bg-white/[0.03] border border-white/10 rounded-xl p-3 flex flex-col gap-2"
                    >
                      <div className="flex justify-center">
                        {/* Same hugging plate as the market cards. */}
                        <div className="bg-black/20 rounded-lg py-2 px-3">
                          <SpritePreview pet={pet} size={64} />
                        </div>
                      </div>
                      <div className="min-h-0">
                        <p className="text-xs font-medium truncate" title={pet.displayName}>
                          {equipped && <span className="text-emerald-400 mr-1">●</span>}
                          {pet.displayName || pet.id}
                        </p>
                        <p className="text-[10px] text-white/40 truncate">{pet.description || '—'}</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 mt-auto">
                        <button
                          style={actionBtnStyle}
                          onClick={() => onEquip(pet)}
                          disabled={equipped}
                          className="hover:bg-white/10 disabled:opacity-40"
                        >
                          {t('petGallery.equip')}
                        </button>
                        <button
                          style={actionBtnStyle}
                          onClick={() => onAddToQueue(pet.id)}
                          className="hover:bg-white/10"
                        >
                          {t('petGallery.addToQueue')}
                        </button>
                        <button
                          style={actionBtnStyle}
                          onClick={() => void toggleFavorite(pet.id)}
                          title={t('petGallery.favorite')}
                          className="hover:bg-white/10"
                        >
                          <Star
                            className="w-3 h-3"
                            fill={fav ? '#fbbf24' : 'none'}
                            color={fav ? '#fbbf24' : 'rgba(255,255,255,0.6)'}
                          />
                        </button>
                        <button
                          style={actionBtnStyle}
                          onClick={() => void openLocalDetail(pet)}
                          title={t('petGallery.details')}
                          className="hover:bg-white/10"
                        >
                          <Info className="w-3 h-3" />
                        </button>
                        <button
                          style={{ ...actionBtnStyle, marginLeft: 'auto', color: 'rgba(255,120,120,0.85)' }}
                          onClick={() => void handleDelete(pet.id)}
                          title={t('petGallery.delete')}
                          className="hover:bg-rose-500/15"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Details modal */}
      {detail && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setDetail(null)}
        >
          <div
            className="bg-[#1e1e1e] border border-white/10 rounded-xl p-5 w-[min(420px,90vw)] max-h-[80vh] overflow-y-auto scrollbar-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="flex justify-center bg-black/20 rounded-lg p-2 shrink-0">
                {detail.kind === 'market' ? (
                  <SpritePreview pet={petdexPetToCodexPet(detail.pet)} size={72} />
                ) : (
                  <SpritePreview pet={detail.pet} size={72} />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold break-words">
                  {detail.kind === 'market' ? detail.pet.displayName || detail.pet.slug : detail.pet.displayName || detail.pet.id}
                </p>
                <p className="text-[11px] text-white/45 break-words mt-0.5">
                  {detail.kind === 'market'
                    ? t(KIND_LABEL_KEYS[detail.pet.kind])
                    : detail.pet.description || '—'}
                </p>
              </div>
              <button onClick={() => setDetail(null)} className="text-white/50 hover:text-white shrink-0">
                <X className="w-4 h-4" />
              </button>
            </div>

            <dl className="mt-4 space-y-2 text-[11px]">
              {detail.kind === 'market' ? (
                <>
                  <div className="flex gap-2">
                    <dt className="text-white/40 w-20 shrink-0">Kind</dt>
                    <dd className="text-white/85 break-words">{t(KIND_LABEL_KEYS[detail.pet.kind])}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-white/40 w-20 shrink-0">{t('petGallery.author')}</dt>
                    <dd className="text-white/85 break-words">{detail.pet.submittedBy}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-white/40 w-20 shrink-0">Slug</dt>
                    <dd className="text-white/85 break-words">{detail.pet.slug}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-white/40 w-20 shrink-0">Version</dt>
                    <dd className="text-white/85 break-words">{detail.pet.spriteVersionNumber}</dd>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex gap-2">
                    <dt className="text-white/40 w-20 shrink-0">ID</dt>
                    <dd className="text-white/85 break-words">{detail.pet.id}</dd>
                  </div>
                  {detail.source?.author_name && (
                    <div className="flex gap-2">
                      <dt className="text-white/40 w-20 shrink-0">{t('petGallery.author')}</dt>
                      <dd className="text-white/85 break-words">{detail.source.author_name}</dd>
                    </div>
                  )}
                  {detail.source?.license && (
                    <div className="flex gap-2">
                      <dt className="text-white/40 w-20 shrink-0">License</dt>
                      <dd className="text-white/85 break-words">{detail.source.license}</dd>
                    </div>
                  )}
                  {detail.source?.tags && detail.source.tags.length > 0 && (
                    <div className="flex gap-2">
                      <dt className="text-white/40 w-20 shrink-0">Tags</dt>
                      <dd className="text-white/85 break-words">{detail.source.tags.join(', ')}</dd>
                    </div>
                  )}
                </>
              )}
            </dl>

            <div className="mt-4 flex items-center gap-2">
              {detail.kind === 'local' ? (
                <>
                  <button
                    style={actionBtnStyle}
                    onClick={() => {
                      onEquip(detail.pet)
                      setDetail(null)
                    }}
                    className="hover:bg-white/10"
                  >
                    {t('petGallery.equip')}
                  </button>
                  <button
                    style={actionBtnStyle}
                    onClick={() => {
                      onAddToQueue(detail.pet.id)
                      setDetail(null)
                    }}
                    className="hover:bg-white/10"
                  >
                    {t('petGallery.addToQueue')}
                  </button>
                  <button
                    style={{ ...actionBtnStyle, marginLeft: 'auto' }}
                    onClick={() => setDetail(null)}
                    className="hover:bg-white/10"
                  >
                    {t('common.cancel')}
                  </button>
                </>
              ) : (
                <button
                  style={{ ...actionBtnStyle, marginLeft: 'auto' }}
                  onClick={() => setDetail(null)}
                  className="hover:bg-white/10"
                >
                  {t('common.cancel')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
