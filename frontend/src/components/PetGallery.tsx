// Pet Gallery: browse and one-click install pet skins from the petdex.dev
// registry, and manage locally installed skins (equip, queue, favorite, delete,
// details, multi-action animation preview).

import { Component, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  ArrowUpDown,
  Box,
  Check,
  Download,
  Info,
  Layers,
  ListMinus,
  ListPlus,
  Loader2,
  PawPrint,
  RotateCw,
  Search,
  Sparkles,
  Star,
  Trash2,
  User,
  X,
} from 'lucide-react'
import { SpritePet } from './SpritePet'
import {
  type CodexPet,
  type CodexPetState,
  type PetdexPet,
  downloadMarketPet,
  deleteLocalPet,
  loadCustomCodexPets,
  loadCodexPets,
  loadPetdexManifest,
  clearCodexPetCache,
} from '../lib/codexPet'
import { loadPetFavorites, savePetFavorites } from '../lib/petStore'

interface PetGalleryProps {
  miniPetId: string | null
  onEquip: (pet: CodexPet) => void
  onAddToQueue: (id: string) => void
  queueIds?: string[]
  onChangeQueue?: (next: string[]) => void
}

const MARKET_PAGE_SIZE = 48

type KindFilter = 'all' | 'creature' | 'character' | 'object'
type OriginFilter = 'all' | 'builtin' | 'custom'
type SortOption = 'name-asc' | 'name-desc' | 'author' | 'version'

const KIND_LABEL_KEYS: Record<'creature' | 'character' | 'object', string> = {
  creature: 'petGallery.kindCreature',
  character: 'petGallery.kindCharacter',
  object: 'petGallery.kindObject',
}

const PREVIEW_ANIMATION_STATES: { state: CodexPetState; labelKey: string }[] = [
  { state: 'idle', labelKey: 'petGallery.stateIdle' },
  { state: 'run-right', labelKey: 'petGallery.stateRun' },
  { state: 'jumping', labelKey: 'petGallery.stateJump' },
  { state: 'waving', labelKey: 'petGallery.stateWave' },
  { state: 'waiting', labelKey: 'petGallery.stateWait' },
  { state: 'failed', labelKey: 'petGallery.stateFailed' },
  { state: 'review', labelKey: 'petGallery.stateReview' },
]

function petdexPetToCodexPet(p: PetdexPet): CodexPet {
  return {
    id: p.slug,
    displayName: p.displayName,
    description: '',
    spritesheetUrl: p.spritesheetUrl,
  }
}

// Error boundary around each SpritePet preview so a single broken skin
// degrades to a placeholder instead of crashing the whole section.
interface SpritePreviewProps {
  pet: CodexPet
  size: number
  state?: CodexPetState
  loop?: boolean
  className?: string
}

class SpritePreview extends Component<SpritePreviewProps, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(err: unknown): void {
    console.warn('[PetGallery] sprite preview failed for', this.props.pet.id, err)
  }

  componentDidUpdate(prev: SpritePreviewProps): void {
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
            fontSize: Math.max(16, Math.round(this.props.size * 0.35)),
            color: 'rgba(255,255,255,0.3)',
            background: 'rgba(255,255,255,0.03)',
            borderRadius: 8,
          }}
        >
          🖼️
        </div>
      )
    }
    return (
      <SpritePet
        pet={this.props.pet}
        state={this.props.state ?? 'idle'}
        size={this.props.size}
        loop={this.props.loop ?? true}
        className={this.props.className}
      />
    )
  }
}

interface LocalSource {
  author_name?: string
  license?: string
  tags?: string[]
}

type DetailItem =
  | { kind: 'market'; pet: PetdexPet }
  | { kind: 'local'; pet: CodexPet; isBuiltin: boolean; source: LocalSource | null }

export function PetGallery({
  miniPetId,
  onEquip,
  onAddToQueue,
  queueIds = [],
  onChangeQueue,
}: PetGalleryProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'market' | 'skins'>('market')

  // Search & Filter state
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [kind, setKind] = useState<KindFilter>('all')
  const [originFilter, setOriginFilter] = useState<OriginFilter>('all')
  const [onlyFavorites, setOnlyFavorites] = useState(false)
  const [sortBy, setSortBy] = useState<SortOption>('name-asc')

  // Market state
  const [marketPets, setMarketPets] = useState<PetdexPet[]>([])
  const [visibleCount, setVisibleCount] = useState(MARKET_PAGE_SIZE)
  const [marketLoading, setMarketLoading] = useState(false)
  const [marketError, setMarketError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState<Set<string>>(new Set())

  // Local skins + favorites
  const [customs, setCustoms] = useState<CodexPet[]>([])
  const [builtins, setBuiltins] = useState<CodexPet[]>([])
  const [favorites, setFavorites] = useState<string[]>([])
  const [detail, setDetail] = useState<DetailItem | null>(null)
  const [detailAnimState, setDetailAnimState] = useState<CodexPetState>('idle')
  const [localSources, setLocalSources] = useState<Record<string, LocalSource | null>>({})
  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null)

  // Load custom and builtin skins
  const refreshLocalSkins = useCallback(async () => {
    clearCodexPetCache()
    const [b, c] = await Promise.all([loadCodexPets(), loadCustomCodexPets()])
    setBuiltins(b)
    const builtinIds = new Set(b.map((p) => p.id))
    setCustoms(c.filter((p) => !builtinIds.has(p.id)))
  }, [])

  const refreshFavorites = useCallback(async () => {
    setFavorites(await loadPetFavorites())
  }, [])

  const fetchManifest = useCallback(() => {
    setMarketLoading(true)
    setMarketError(null)
    loadPetdexManifest()
      .then((pets) => {
        setMarketPets(pets)
      })
      .catch((e) => {
        setMarketError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        setMarketLoading(false)
      })
  }, [])

  useEffect(() => {
    void refreshLocalSkins()
    void refreshFavorites()
  }, [refreshLocalSkins, refreshFavorites])

  useEffect(() => {
    fetchManifest()
  }, [fetchManifest])

  // Debounced search query
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), 300)
    return () => clearTimeout(timer)
  }, [q])

  // Reset pagination when search or filters change
  useEffect(() => {
    setVisibleCount(MARKET_PAGE_SIZE)
  }, [debouncedQ, kind, originFilter, onlyFavorites, sortBy])

  // Reset detail animation state when opening a new detail item
  useEffect(() => {
    setDetailAnimState('idle')
  }, [detail])

  const loadMore = useCallback(() => {
    setVisibleCount((c) => c + MARKET_PAGE_SIZE)
  }, [])

  const toggleFavorite = useCallback(async (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    setFavorites((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      void savePetFavorites(next)
      return next
    })
  }, [])

  const handleToggleQueue = useCallback(
    (id: string, e?: React.MouseEvent) => {
      e?.stopPropagation()
      if (onChangeQueue) {
        if (queueIds.includes(id)) {
          onChangeQueue(queueIds.filter((x) => x !== id))
        } else {
          onChangeQueue([...queueIds, id])
        }
      } else {
        onAddToQueue(id)
      }
    },
    [onChangeQueue, onAddToQueue, queueIds],
  )

  const handleDownload = useCallback(
    async (slug: string, zipUrl: string, e?: React.MouseEvent) => {
      e?.stopPropagation()
      setDownloading((prev) => new Set(prev).add(slug))
      try {
        await downloadMarketPet(slug, zipUrl)
        await refreshLocalSkins()
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
    [refreshLocalSkins, t],
  )

  const handleDelete = useCallback(
    async (id: string, e?: React.MouseEvent) => {
      e?.stopPropagation()
      if (!window.confirm(t('petGallery.deleteConfirm', { name: id }))) return
      try {
        await deleteLocalPet(id)
        await refreshLocalSkins()
        if (detail?.kind === 'local' && detail.pet.id === id) {
          setDetail(null)
        }
      } catch (e) {
        console.warn('[PetGallery] delete failed:', e)
        window.alert(e instanceof Error ? e.message : String(e))
      }
    },
    [refreshLocalSkins, detail, t],
  )

  const openLocalDetail = useCallback(
    async (pet: CodexPet, isBuiltin: boolean) => {
      setDetail({ kind: 'local', pet, isBuiltin, source: localSources[pet.id] ?? null })
      if (isBuiltin || localSources[pet.id] !== undefined) return
      let source: LocalSource | null = null
      try {
        const srcUrl = pet.spritesheetUrl.replace(/\/[^/]*$/, '/source.json')
        const res = await fetch(srcUrl)
        if (res.ok) source = (await res.json()) as LocalSource
      } catch {
        source = null
      }
      setLocalSources((prev) => ({ ...prev, [pet.id]: source }))
      setDetail({ kind: 'local', pet, isBuiltin, source })
    },
    [localSources],
  )

  const installedCustomIds = useMemo(() => new Set(customs.map((c) => c.id)), [customs])
  const builtinIds = useMemo(() => new Set(builtins.map((b) => b.id)), [builtins])
  const allInstalledIds = useMemo(() => new Set([...installedCustomIds, ...builtinIds]), [installedCustomIds, builtinIds])
  const favSet = useMemo(() => new Set(favorites), [favorites])
  const queueSet = useMemo(() => new Set(queueIds), [queueIds])

  // Filtered & sorted Market pets
  const filteredMarketPets = useMemo(() => {
    const needle = debouncedQ.trim().toLowerCase()
    let list = marketPets

    if (kind !== 'all') {
      list = list.filter((p) => p.kind === kind)
    }
    if (onlyFavorites) {
      list = list.filter((p) => favSet.has(p.slug))
    }
    if (needle) {
      list = list.filter(
        (p) =>
          p.displayName.toLowerCase().includes(needle) ||
          p.slug.toLowerCase().includes(needle) ||
          (p.submittedBy && p.submittedBy.toLowerCase().includes(needle)),
      )
    }

    return [...list].sort((a, b) => {
      if (sortBy === 'name-asc') return a.displayName.localeCompare(b.displayName)
      if (sortBy === 'name-desc') return b.displayName.localeCompare(a.displayName)
      if (sortBy === 'author') return (a.submittedBy || '').localeCompare(b.submittedBy || '')
      if (sortBy === 'version') return (b.spriteVersionNumber || 0) - (a.spriteVersionNumber || 0)
      return 0
    })
  }, [marketPets, debouncedQ, kind, onlyFavorites, favSet, sortBy])

  const visibleMarketPets = useMemo(() => filteredMarketPets.slice(0, visibleCount), [filteredMarketPets, visibleCount])
  const hasMoreMarket = visibleMarketPets.length < filteredMarketPets.length

  // Filtered & sorted Local skins (Customs + Builtins)
  const allLocalSkins = useMemo(() => {
    const bList = builtins.map((p) => ({ pet: p, isBuiltin: true }))
    const cList = customs.map((p) => ({ pet: p, isBuiltin: false }))
    return [...bList, ...cList]
  }, [builtins, customs])

  const filteredLocalSkins = useMemo(() => {
    const needle = debouncedQ.trim().toLowerCase()
    let list = allLocalSkins

    if (originFilter === 'builtin') {
      list = list.filter((item) => item.isBuiltin)
    } else if (originFilter === 'custom') {
      list = list.filter((item) => !item.isBuiltin)
    }

    if (onlyFavorites) {
      list = list.filter((item) => favSet.has(item.pet.id))
    }

    if (needle) {
      list = list.filter(
        (item) =>
          item.pet.displayName.toLowerCase().includes(needle) ||
          item.pet.id.toLowerCase().includes(needle) ||
          (item.pet.description && item.pet.description.toLowerCase().includes(needle)),
      )
    }

    return [...list].sort((a, b) => {
      if (sortBy === 'name-asc') return a.pet.displayName.localeCompare(b.pet.displayName)
      if (sortBy === 'name-desc') return b.pet.displayName.localeCompare(a.pet.displayName)
      return 0
    })
  }, [allLocalSkins, debouncedQ, originFilter, onlyFavorites, favSet, sortBy])

  const clearAllFilters = useCallback(() => {
    setQ('')
    setDebouncedQ('')
    setKind('all')
    setOriginFilter('all')
    setOnlyFavorites(false)
  }, [])

  return (
    <div className="h-full flex flex-col bg-[#141416] text-white font-sans antialiased select-none">
      {/* ─── Top Header & Tab Navigation ─── */}
      <div className="px-4 pt-3.5 pb-2.5 border-b border-white/[0.08] bg-[#17171a]/95 backdrop-blur-md shrink-0 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          {/* Segmented Tab Controls */}
          <div className="flex items-center p-1 bg-black/40 border border-white/10 rounded-xl">
            <button
              onClick={() => setTab('market')}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all duration-150 cursor-pointer ${
                tab === 'market'
                  ? 'bg-white/15 text-white shadow-sm ring-1 ring-white/10'
                  : 'text-white/50 hover:text-white/80 hover:bg-white/5'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{t('petGallery.market')}</span>
              {marketPets.length > 0 && (
                <span className="ml-1 px-1.5 py-0.2 text-[10px] rounded-full bg-white/10 text-white/70 font-mono">
                  {marketPets.length}
                </span>
              )}
            </button>
            <button
              onClick={() => setTab('skins')}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all duration-150 cursor-pointer ${
                tab === 'skins'
                  ? 'bg-white/15 text-white shadow-sm ring-1 ring-white/10'
                  : 'text-white/50 hover:text-white/80 hover:bg-white/5'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              <span>{t('petGallery.mySkins')}</span>
              <span className="ml-1 px-1.5 py-0.2 text-[10px] rounded-full bg-white/10 text-white/70 font-mono">
                {allLocalSkins.length}
              </span>
            </button>
          </div>

          {/* Quick Actions & Refresh */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                if (tab === 'market') fetchManifest()
                void refreshLocalSkins()
                void refreshFavorites()
              }}
              title={t('petGallery.refresh')}
              className="p-1.5 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-all cursor-pointer"
            >
              <RotateCw className={`w-3.5 h-3.5 ${marketLoading ? 'animate-spin text-amber-400' : ''}`} />
            </button>
          </div>
        </div>

        {/* ─── Search, Filter & Sort Bar ─── */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Search Box */}
          <div className="relative flex-1 min-w-[180px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/35 pointer-events-none" />
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('petGallery.searchPlaceholder')}
              className="w-full bg-black/30 border border-white/10 focus:border-white/25 rounded-xl pl-8 pr-8 py-1.5 text-xs text-white placeholder:text-white/30 outline-none transition-all"
            />
            {q && (
              <button
                onClick={() => setQ('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-white/40 hover:text-white hover:bg-white/10"
                title={t('petGallery.clearSearch')}
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          {/* Filter Chips / Selectors */}
          {tab === 'market' ? (
            <div className="flex items-center gap-1 overflow-x-auto scrollbar-hidden py-0.5">
              {(['all', 'creature', 'character', 'object'] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all cursor-pointer flex items-center gap-1 border ${
                    kind === k
                      ? 'bg-white/15 border-white/25 text-white shadow-sm'
                      : 'bg-white/[0.03] border-white/10 text-white/50 hover:text-white/80 hover:bg-white/[0.07]'
                  }`}
                >
                  {k === 'creature' && <PawPrint className="w-3 h-3" />}
                  {k === 'character' && <User className="w-3 h-3" />}
                  {k === 'object' && <Box className="w-3 h-3" />}
                  <span>{t(k === 'all' ? 'petGallery.kindAll' : KIND_LABEL_KEYS[k])}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-1 overflow-x-auto scrollbar-hidden py-0.5">
              {(['all', 'builtin', 'custom'] as const).map((orig) => (
                <button
                  key={orig}
                  onClick={() => setOriginFilter(orig)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all cursor-pointer border ${
                    originFilter === orig
                      ? 'bg-white/15 border-white/25 text-white shadow-sm'
                      : 'bg-white/[0.03] border-white/10 text-white/50 hover:text-white/80 hover:bg-white/[0.07]'
                  }`}
                >
                  {orig === 'all' && t('petGallery.originAll')}
                  {orig === 'builtin' && t('petGallery.originBuiltin')}
                  {orig === 'custom' && t('petGallery.originCustom')}
                </button>
              ))}
            </div>
          )}

          {/* Favorites Only Toggle */}
          <button
            onClick={() => setOnlyFavorites((prev) => !prev)}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all cursor-pointer flex items-center gap-1 border ${
              onlyFavorites
                ? 'bg-amber-500/20 border-amber-500/40 text-amber-300 shadow-sm'
                : 'bg-white/[0.03] border-white/10 text-white/50 hover:text-white/80 hover:bg-white/[0.07]'
            }`}
          >
            <Star className="w-3 h-3" fill={onlyFavorites ? '#fbbf24' : 'none'} color={onlyFavorites ? '#fbbf24' : 'currentColor'} />
            <span>{t('petGallery.favoritesOnly')}</span>
          </button>

          {/* Sort Selector */}
          <div className="relative flex items-center">
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
              className="bg-black/30 border border-white/10 focus:border-white/25 rounded-xl px-2.5 py-1 text-[11px] text-white/80 outline-none cursor-pointer appearance-none pr-6"
            >
              <option value="name-asc" className="bg-[#1e1e22] text-white">{t('petGallery.sortNameAsc')}</option>
              <option value="name-desc" className="bg-[#1e1e22] text-white">{t('petGallery.sortNameDesc')}</option>
              {tab === 'market' && (
                <>
                  <option value="author" className="bg-[#1e1e22] text-white">{t('petGallery.sortAuthor')}</option>
                  <option value="version" className="bg-[#1e1e22] text-white">{t('petGallery.sortNewest')}</option>
                </>
              )}
            </select>
            <ArrowUpDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-white/35 pointer-events-none" />
          </div>
        </div>
      </div>

      {/* ─── Main Content Area ─── */}
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hidden p-4">
        {/* Error Alert Box */}
        {tab === 'market' && marketError && (
          <div className="mb-4 flex items-start justify-between gap-3 p-3.5 bg-rose-500/10 border border-rose-500/25 rounded-xl text-xs text-rose-300">
            <div className="flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-rose-200">{t('petGallery.downloadFailed')}</p>
                <p className="text-[11px] text-rose-300/80 mt-0.5 break-words">{marketError}</p>
              </div>
            </div>
            <button
              onClick={fetchManifest}
              className="shrink-0 px-2.5 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 text-[11px] font-medium border border-rose-500/30 cursor-pointer"
            >
              {t('petGallery.retry')}
            </button>
          </div>
        )}

        {/* ─── Market Tab View ─── */}
        {tab === 'market' && (
          <div>
            {/* Loading Skeleton */}
            {marketLoading && marketPets.length === 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 gap-3.5">
                {Array.from({ length: 8 }).map((_, idx) => (
                  <div
                    key={idx}
                    className="bg-white/[0.02] border border-white/5 rounded-2xl p-3.5 flex flex-col gap-3 animate-pulse"
                  >
                    <div className="h-24 bg-white/5 rounded-xl" />
                    <div className="h-3.5 w-2/3 bg-white/10 rounded" />
                    <div className="h-2.5 w-1/3 bg-white/5 rounded" />
                    <div className="h-6 w-full bg-white/5 rounded-lg mt-auto" />
                  </div>
                ))}
              </div>
            )}

            {/* Market Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 gap-3.5">
              {visibleMarketPets.map((p) => {
                const installed = allInstalledIds.has(p.slug)
                const isDownloading = downloading.has(p.slug)
                const fav = favSet.has(p.slug)
                const equipped = miniPetId === p.slug
                const codexPet = petdexPetToCodexPet(p)
                const isHovered = hoveredCardId === p.slug

                return (
                  <div
                    key={p.slug}
                    onMouseEnter={() => setHoveredCardId(p.slug)}
                    onMouseLeave={() => setHoveredCardId(null)}
                    className="group relative bg-[#19191d]/90 hover:bg-[#202026] border border-white/10 hover:border-white/25 rounded-2xl p-3.5 flex flex-col gap-2.5 transition-all duration-200 hover:shadow-xl hover:shadow-black/50 hover:-translate-y-0.5"
                  >
                    {/* Top Status Badges + Favorite Star */}
                    <div className="flex items-center justify-between gap-1 min-h-[20px]">
                      <div className="flex items-center gap-1 flex-wrap">
                        <span
                          className={`text-[9px] px-1.5 py-0.5 rounded-md font-medium tracking-wide uppercase ${
                            p.kind === 'creature'
                              ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/25'
                              : p.kind === 'character'
                              ? 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/25'
                              : 'bg-amber-500/15 text-amber-300 border border-amber-500/25'
                          }`}
                        >
                          {t(KIND_LABEL_KEYS[p.kind])}
                        </span>
                        {equipped && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded-md font-medium bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                            {t('petGallery.equipped')}
                          </span>
                        )}
                      </div>
                      <button
                        onClick={(e) => void toggleFavorite(p.slug, e)}
                        title={t('petGallery.favorite')}
                        className="p-1 rounded-md hover:bg-white/10 text-white/40 hover:text-amber-400 transition-colors cursor-pointer"
                      >
                        <Star
                          className="w-3.5 h-3.5 transition-transform group-hover:scale-105"
                          fill={fav ? '#fbbf24' : 'none'}
                          color={fav ? '#fbbf24' : 'currentColor'}
                        />
                      </button>
                    </div>

                    {/* Sprite Stage Area */}
                    <div
                      onClick={() => setDetail({ kind: 'market', pet: p })}
                      className="relative bg-black/35 ring-1 ring-white/5 group-hover:ring-white/15 rounded-xl py-3 px-2 flex items-center justify-center cursor-pointer transition-all duration-200 overflow-hidden"
                    >
                      <div className="absolute inset-0 bg-gradient-to-t from-black/20 via-transparent to-transparent pointer-events-none" />
                      <div className="relative z-10 transition-transform duration-200 group-hover:scale-110">
                        <SpritePreview
                          pet={codexPet}
                          size={64}
                          state={isHovered ? 'run-right' : 'idle'}
                        />
                      </div>
                    </div>

                    {/* Meta info */}
                    <div className="min-h-0 flex-1">
                      <p
                        className="text-xs font-semibold text-white/90 group-hover:text-white truncate"
                        title={p.displayName || p.slug}
                      >
                        {p.displayName || p.slug}
                      </p>
                      <div className="flex items-center gap-1.5 text-[10px] text-white/45 mt-0.5 truncate">
                        {p.submittedBy ? (
                          <span className="flex items-center gap-0.5 truncate">
                            <User className="w-2.5 h-2.5 shrink-0 opacity-60" />
                            <span className="truncate">{p.submittedBy}</span>
                          </span>
                        ) : (
                          <span className="font-mono text-white/30 truncate">@{p.slug}</span>
                        )}
                      </div>
                    </div>

                    {/* Action Bar */}
                    <div className="flex items-center gap-1.5 pt-1 border-t border-white/5 mt-auto">
                      {isDownloading ? (
                        <div className="flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 bg-amber-500/15 border border-amber-500/30 rounded-xl text-[11px] text-amber-300 font-medium">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          <span>{t('petGallery.downloading')}</span>
                        </div>
                      ) : installed ? (
                        <>
                          <button
                            onClick={() => onEquip(codexPet)}
                            disabled={equipped}
                            className={`flex-1 flex items-center justify-center gap-1 py-1.5 px-2 rounded-xl text-[11px] font-medium transition-all cursor-pointer ${
                              equipped
                                ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 cursor-default opacity-80'
                                : 'bg-white/10 hover:bg-white/20 border border-white/15 text-white active:scale-95'
                            }`}
                          >
                            {equipped ? (
                              <>
                                <Check className="w-3 h-3" />
                                <span>{t('petGallery.equipped')}</span>
                              </>
                            ) : (
                              <span>{t('petGallery.equip')}</span>
                            )}
                          </button>
                          <button
                            onClick={() => setDetail({ kind: 'market', pet: p })}
                            title={t('petGallery.details')}
                            className="p-1.5 rounded-xl border border-white/10 bg-white/5 hover:bg-white/15 text-white/60 hover:text-white transition-all cursor-pointer"
                          >
                            <Info className="w-3.5 h-3.5" />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={(e) => void handleDownload(p.slug, p.zipUrl, e)}
                            className="flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2.5 rounded-xl bg-gradient-to-r from-sky-500/80 to-blue-600/80 hover:from-sky-500 hover:to-blue-600 text-white text-[11px] font-medium shadow-sm transition-all active:scale-95 cursor-pointer"
                          >
                            <Download className="w-3 h-3" />
                            <span>{t('petGallery.download')}</span>
                          </button>
                          <button
                            onClick={() => setDetail({ kind: 'market', pet: p })}
                            title={t('petGallery.details')}
                            className="p-1.5 rounded-xl border border-white/10 bg-white/5 hover:bg-white/15 text-white/60 hover:text-white transition-all cursor-pointer"
                          >
                            <Info className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Empty States */}
            {filteredMarketPets.length === 0 && !marketLoading && !marketError && (
              <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
                <div className="w-12 h-12 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center text-white/40 mb-3">
                  {onlyFavorites ? <Star className="w-6 h-6 text-amber-400/60" /> : <Search className="w-6 h-6" />}
                </div>
                <p className="text-sm font-medium text-white/80">
                  {onlyFavorites ? t('petGallery.emptyFavoritesTitle') : t('petGallery.emptySearchTitle')}
                </p>
                <p className="text-xs text-white/45 max-w-sm mt-1">
                  {onlyFavorites
                    ? t('petGallery.emptyFavoritesDesc')
                    : t('petGallery.emptySearchDesc', { query: q || t('petGallery.kindAll') })}
                </p>
                <button
                  onClick={clearAllFilters}
                  className="mt-4 px-3.5 py-1.5 rounded-xl bg-white/10 hover:bg-white/15 border border-white/15 text-xs text-white transition-all cursor-pointer"
                >
                  {t('petGallery.clearFilters')}
                </button>
              </div>
            )}

            {/* Load More Pagination Button */}
            {hasMoreMarket && (
              <div className="flex justify-center mt-6 mb-2">
                <button
                  onClick={loadMore}
                  className="flex items-center gap-2 px-5 py-2 rounded-xl bg-white/5 hover:bg-white/15 border border-white/15 text-xs font-medium text-white/80 hover:text-white transition-all shadow-sm active:scale-95 cursor-pointer"
                >
                  <span>{t('petGallery.remainingCount', { count: filteredMarketPets.length - visibleMarketPets.length })}</span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* ─── My Skins Tab View ─── */}
        {tab === 'skins' && (
          <div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 gap-3.5">
              {filteredLocalSkins.map(({ pet, isBuiltin }) => {
                const equipped = miniPetId === pet.id
                const inQueue = queueSet.has(pet.id)
                const fav = favSet.has(pet.id)
                const isHovered = hoveredCardId === pet.id

                return (
                  <div
                    key={pet.id}
                    onMouseEnter={() => setHoveredCardId(pet.id)}
                    onMouseLeave={() => setHoveredCardId(null)}
                    className="group relative bg-[#19191d]/90 hover:bg-[#202026] border border-white/10 hover:border-white/25 rounded-2xl p-3.5 flex flex-col gap-2.5 transition-all duration-200 hover:shadow-xl hover:shadow-black/50 hover:-translate-y-0.5"
                  >
                    {/* Top Badges & Favorite */}
                    <div className="flex items-center justify-between gap-1 min-h-[20px]">
                      <div className="flex items-center gap-1 flex-wrap">
                        <span
                          className={`text-[9px] px-1.5 py-0.5 rounded-md font-medium tracking-wide uppercase ${
                            isBuiltin
                              ? 'bg-purple-500/15 text-purple-300 border border-purple-500/25'
                              : 'bg-teal-500/15 text-teal-300 border border-teal-500/25'
                          }`}
                        >
                          {isBuiltin ? t('petGallery.originBuiltin') : t('petGallery.originCustom')}
                        </span>
                        {equipped && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded-md font-medium bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                            {t('petGallery.equipped')}
                          </span>
                        )}
                        {inQueue && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded-md font-medium bg-sky-500/15 text-sky-300 border border-sky-500/25">
                            {t('petGallery.inQueue')}
                          </span>
                        )}
                      </div>
                      <button
                        onClick={(e) => void toggleFavorite(pet.id, e)}
                        title={t('petGallery.favorite')}
                        className="p-1 rounded-md hover:bg-white/10 text-white/40 hover:text-amber-400 transition-colors cursor-pointer"
                      >
                        <Star
                          className="w-3.5 h-3.5 transition-transform group-hover:scale-105"
                          fill={fav ? '#fbbf24' : 'none'}
                          color={fav ? '#fbbf24' : 'currentColor'}
                        />
                      </button>
                    </div>

                    {/* Sprite Stage Area */}
                    <div
                      onClick={() => void openLocalDetail(pet, isBuiltin)}
                      className="relative bg-black/35 ring-1 ring-white/5 group-hover:ring-white/15 rounded-xl py-3 px-2 flex items-center justify-center cursor-pointer transition-all duration-200 overflow-hidden"
                    >
                      <div className="absolute inset-0 bg-gradient-to-t from-black/20 via-transparent to-transparent pointer-events-none" />
                      <div className="relative z-10 transition-transform duration-200 group-hover:scale-110">
                        <SpritePreview
                          pet={pet}
                          size={64}
                          state={isHovered ? 'run-right' : 'idle'}
                        />
                      </div>
                    </div>

                    {/* Meta info */}
                    <div className="min-h-0 flex-1">
                      <p
                        className="text-xs font-semibold text-white/90 group-hover:text-white truncate"
                        title={pet.displayName || pet.id}
                      >
                        {pet.displayName || pet.id}
                      </p>
                      <p className="text-[10px] text-white/40 truncate mt-0.5">
                        {pet.description || <span className="font-mono text-white/30">@{pet.id}</span>}
                      </p>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-white/5 mt-auto">
                      <button
                        onClick={() => onEquip(pet)}
                        disabled={equipped}
                        className={`flex-1 min-w-[50px] flex items-center justify-center gap-1 py-1.5 px-2 rounded-xl text-[11px] font-medium transition-all cursor-pointer ${
                          equipped
                            ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 cursor-default opacity-80'
                            : 'bg-white/10 hover:bg-white/20 border border-white/15 text-white active:scale-95'
                        }`}
                      >
                        {equipped ? (
                          <>
                            <Check className="w-3 h-3" />
                            <span>{t('petGallery.equipped')}</span>
                          </>
                        ) : (
                          <span>{t('petGallery.equip')}</span>
                        )}
                      </button>

                      <button
                        onClick={(e) => handleToggleQueue(pet.id, e)}
                        title={inQueue ? t('petGallery.removeFromQueue') : t('petGallery.addToQueue')}
                        className={`p-1.5 rounded-xl border transition-all cursor-pointer ${
                          inQueue
                            ? 'bg-sky-500/20 border-sky-500/35 text-sky-300 hover:bg-sky-500/30'
                            : 'bg-white/5 border-white/10 hover:bg-white/15 text-white/60 hover:text-white'
                        }`}
                      >
                        {inQueue ? <ListMinus className="w-3.5 h-3.5" /> : <ListPlus className="w-3.5 h-3.5" />}
                      </button>

                      <button
                        onClick={() => void openLocalDetail(pet, isBuiltin)}
                        title={t('petGallery.details')}
                        className="p-1.5 rounded-xl border border-white/10 bg-white/5 hover:bg-white/15 text-white/60 hover:text-white transition-all cursor-pointer"
                      >
                        <Info className="w-3.5 h-3.5" />
                      </button>

                      {!isBuiltin && (
                        <button
                          onClick={(e) => void handleDelete(pet.id, e)}
                          title={t('petGallery.delete')}
                          className="p-1.5 rounded-xl border border-rose-500/20 bg-rose-500/10 hover:bg-rose-500/25 text-rose-300 transition-all cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Empty Skins State */}
            {filteredLocalSkins.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
                <div className="w-12 h-12 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center text-white/40 mb-3">
                  {onlyFavorites ? (
                    <Star className="w-6 h-6 text-amber-400/60" />
                  ) : (
                    <Layers className="w-6 h-6" />
                  )}
                </div>
                <p className="text-sm font-medium text-white/80">
                  {onlyFavorites
                    ? t('petGallery.emptyFavoritesTitle')
                    : q
                    ? t('petGallery.emptySearchTitle')
                    : t('petGallery.emptySkinsTitle')}
                </p>
                <p className="text-xs text-white/45 max-w-sm mt-1">
                  {onlyFavorites
                    ? t('petGallery.emptyFavoritesDesc')
                    : q
                    ? t('petGallery.emptySearchDesc', { query: q })
                    : t('petGallery.emptySkinsDesc')}
                </p>
                {allLocalSkins.length === 0 || (!q && !onlyFavorites && originFilter === 'custom') ? (
                  <button
                    onClick={() => setTab('market')}
                    className="mt-4 flex items-center gap-1.5 px-4 py-2 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-400 hover:to-blue-500 text-xs font-medium text-white shadow-lg shadow-sky-500/20 transition-all cursor-pointer"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>{t('petGallery.goToMarket')}</span>
                  </button>
                ) : (
                  <button
                    onClick={clearAllFilters}
                    className="mt-4 px-3.5 py-1.5 rounded-xl bg-white/10 hover:bg-white/15 border border-white/15 text-xs text-white transition-all cursor-pointer"
                  >
                    {t('petGallery.clearFilters')}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ─── Rich Details Modal & Multi-action Preview ─── */}
      {detail && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-150"
          onClick={() => setDetail(null)}
        >
          <div
            className="bg-[#1c1c20] border border-white/15 rounded-2xl shadow-2xl p-5 w-[min(480px,94vw)] max-h-[85vh] overflow-y-auto scrollbar-hidden flex flex-col gap-4 text-white"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-start justify-between gap-3 border-b border-white/10 pb-3">
              <div>
                <h3 className="text-base font-bold text-white break-words">
                  {detail.kind === 'market'
                    ? detail.pet.displayName || detail.pet.slug
                    : detail.pet.displayName || detail.pet.id}
                </h3>
                <p className="text-xs text-white/50 mt-0.5 break-words">
                  {detail.kind === 'market'
                    ? t(KIND_LABEL_KEYS[detail.pet.kind])
                    : detail.pet.description || <span className="font-mono text-white/35">@{detail.pet.id}</span>}
                </p>
              </div>
              <button
                onClick={() => setDetail(null)}
                className="p-1 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Interactive Sprite Stage */}
            <div className="flex flex-col items-center justify-center bg-black/40 ring-1 ring-white/10 rounded-2xl p-4 gap-3">
              <div className="py-2">
                {detail.kind === 'market' ? (
                  <SpritePreview
                    pet={petdexPetToCodexPet(detail.pet)}
                    size={84}
                    state={detailAnimState}
                  />
                ) : (
                  <SpritePreview
                    pet={detail.pet}
                    size={84}
                    state={detailAnimState}
                  />
                )}
              </div>

              {/* Action State Switcher Chips */}
              <div className="w-full flex items-center justify-center gap-1.5 flex-wrap pt-2 border-t border-white/5">
                {PREVIEW_ANIMATION_STATES.map((item) => (
                  <button
                    key={item.state}
                    onClick={() => setDetailAnimState(item.state)}
                    className={`px-2 py-0.5 rounded-lg text-[10px] font-medium transition-all cursor-pointer border ${
                      detailAnimState === item.state
                        ? 'bg-white/20 border-white/30 text-white shadow-sm ring-1 ring-white/10'
                        : 'bg-white/5 border-white/10 text-white/50 hover:text-white/80 hover:bg-white/10'
                    }`}
                  >
                    {t(item.labelKey)}
                  </button>
                ))}
              </div>
            </div>

            {/* Detailed Specs Grid */}
            <div className="bg-white/[0.02] border border-white/5 rounded-xl p-3 space-y-2 text-xs">
              {detail.kind === 'market' ? (
                <>
                  <div className="flex justify-between items-center py-0.5 border-b border-white/5">
                    <span className="text-white/45">{t('petGallery.author')}</span>
                    <span className="font-medium text-white/90">{detail.pet.submittedBy || '—'}</span>
                  </div>
                  <div className="flex justify-between items-center py-0.5 border-b border-white/5">
                    <span className="text-white/45">{t('petGallery.metaSlug')}</span>
                    <span className="font-mono text-white/80 text-[11px]">{detail.pet.slug}</span>
                  </div>
                  <div className="flex justify-between items-center py-0.5 border-b border-white/5">
                    <span className="text-white/45">{t('petGallery.metaVersion')}</span>
                    <span className="font-mono text-white/80 text-[11px]">v{detail.pet.spriteVersionNumber}</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex justify-between items-center py-0.5 border-b border-white/5">
                    <span className="text-white/45">{t('petGallery.metaSlug')}</span>
                    <span className="font-mono text-white/80 text-[11px]">{detail.pet.id}</span>
                  </div>
                  {detail.source?.author_name && (
                    <div className="flex justify-between items-center py-0.5 border-b border-white/5">
                      <span className="text-white/45">{t('petGallery.author')}</span>
                      <span className="font-medium text-white/90">{detail.source.author_name}</span>
                    </div>
                  )}
                  {detail.source?.license && (
                    <div className="flex justify-between items-center py-0.5 border-b border-white/5">
                      <span className="text-white/45">{t('petGallery.metaLicense')}</span>
                      <span className="font-mono text-white/80 text-[11px]">{detail.source.license}</span>
                    </div>
                  )}
                  {detail.source?.tags && detail.source.tags.length > 0 && (
                    <div className="flex justify-between items-center py-0.5 border-b border-white/5">
                      <span className="text-white/45">{t('petGallery.metaTags')}</span>
                      <div className="flex gap-1 flex-wrap justify-end">
                        {detail.source.tags.map((tag) => (
                          <span
                            key={tag}
                            className="px-1.5 py-0.5 rounded bg-white/10 text-[10px] text-white/70 font-mono"
                          >
                            #{tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Modal Bottom Actions */}
            <div className="flex items-center gap-2 pt-1 border-t border-white/10">
              {detail.kind === 'market' ? (
                <>
                  {allInstalledIds.has(detail.pet.slug) ? (
                    <button
                      onClick={() => {
                        onEquip(petdexPetToCodexPet(detail.pet))
                        setDetail(null)
                      }}
                      className="flex-1 py-2 px-3 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-xs font-semibold text-white transition-all cursor-pointer"
                    >
                      {t('petGallery.oneClickEquip')}
                    </button>
                  ) : (
                    <button
                      onClick={(e) => void handleDownload(detail.pet.slug, detail.pet.zipUrl, e)}
                      disabled={downloading.has(detail.pet.slug)}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-400 hover:to-blue-500 text-xs font-semibold text-white transition-all cursor-pointer disabled:opacity-50"
                    >
                      {downloading.has(detail.pet.slug) ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Download className="w-3.5 h-3.5" />
                      )}
                      <span>{t('petGallery.download')}</span>
                    </button>
                  )}
                  <button
                    onClick={(e) => void toggleFavorite(detail.pet.slug, e)}
                    className="p-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-white/70 hover:text-amber-400 transition-colors cursor-pointer"
                    title={t('petGallery.favorite')}
                  >
                    <Star
                      className="w-4 h-4"
                      fill={favSet.has(detail.pet.slug) ? '#fbbf24' : 'none'}
                      color={favSet.has(detail.pet.slug) ? '#fbbf24' : 'currentColor'}
                    />
                  </button>
                  <button
                    onClick={() => setDetail(null)}
                    className="py-2 px-4 rounded-xl border border-white/15 bg-white/5 hover:bg-white/10 text-xs text-white/80 cursor-pointer"
                  >
                    {t('common.cancel')}
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => {
                      onEquip(detail.pet)
                      setDetail(null)
                    }}
                    disabled={miniPetId === detail.pet.id}
                    className="flex-1 py-2 px-3 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-xs font-semibold text-white transition-all cursor-pointer disabled:opacity-50"
                  >
                    {miniPetId === detail.pet.id ? t('petGallery.equipped') : t('petGallery.equip')}
                  </button>
                  <button
                    onClick={(e) => handleToggleQueue(detail.pet.id, e)}
                    className={`py-2 px-3 rounded-xl border text-xs font-medium transition-all cursor-pointer ${
                      queueSet.has(detail.pet.id)
                        ? 'bg-sky-500/20 border-sky-500/40 text-sky-300'
                        : 'bg-white/5 border-white/15 text-white/80 hover:bg-white/10'
                    }`}
                  >
                    {queueSet.has(detail.pet.id) ? t('petGallery.removeFromQueue') : t('petGallery.addToQueue')}
                  </button>
                  <button
                    onClick={(e) => void toggleFavorite(detail.pet.id, e)}
                    className="p-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-white/70 hover:text-amber-400 transition-colors cursor-pointer"
                    title={t('petGallery.favorite')}
                  >
                    <Star
                      className="w-4 h-4"
                      fill={favSet.has(detail.pet.id) ? '#fbbf24' : 'none'}
                      color={favSet.has(detail.pet.id) ? '#fbbf24' : 'currentColor'}
                    />
                  </button>
                  {!detail.isBuiltin && (
                    <button
                      onClick={(e) => void handleDelete(detail.pet.id, e)}
                      className="p-2 rounded-xl border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 transition-colors cursor-pointer"
                      title={t('petGallery.delete')}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                  <button
                    onClick={() => setDetail(null)}
                    className="py-2 px-3 rounded-xl border border-white/15 bg-white/5 hover:bg-white/10 text-xs text-white/80 cursor-pointer"
                  >
                    {t('common.cancel')}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
