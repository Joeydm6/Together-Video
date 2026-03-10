        document.addEventListener('DOMContentLoaded', () => {
            const socket = io();
            const status = document.getElementById('status');
            const breadcrumb = document.getElementById('breadcrumb');
            const pageContext = document.getElementById('page-context');
            
            // View containers
            const continueWatchingRow = document.getElementById('continue-watching-row');
            const favoritesRow = document.getElementById('favorites-row');
            const homepageRowsContainer = document.getElementById('homepage-rows-container');
            const folderViewContainer = document.getElementById('folder-view-container');
            const allVideosGrid = document.getElementById('all-videos-grid');
            const seriesHeaderWrapper = document.getElementById('series-header-wrapper');
            const contextMenu = document.getElementById('context-menu');
            const folderOptionsButton = document.getElementById('folder-options-button');
            const folderOptionsMenu = document.getElementById('folder-options-menu');
            const searchInput = document.getElementById('library-search');
            const clearSearchButton = document.getElementById('clear-search');
            const searchShell = document.querySelector('.app-menu-search-shell');
            const searchAssist = document.getElementById('search-assist');
            const searchStack = document.querySelector('.app-menu-search');
            const installAppButton = document.getElementById('install-app-button');
            const refreshMetadataMenuButton = folderOptionsMenu?.querySelector('[data-action="refresh-metadata"]');
            const changeMetadataMenuButton = folderOptionsMenu?.querySelector('[data-action="change-metadata"]');
            const changeThumbnailMenuButton = folderOptionsMenu?.querySelector('[data-action="change-thumbnail"]');
            const markAllWatchedMenuButton = folderOptionsMenu?.querySelector('[data-action="mark-all-watched"]');
            const markAllUnwatchedMenuButton = folderOptionsMenu?.querySelector('[data-action="mark-all-unwatched"]');
            const thumbnailPicker = document.getElementById('thumbnail-picker');
            const thumbnailPickerGrid = document.getElementById('thumbnail-picker-grid');
            const thumbnailPickerStatus = document.getElementById('thumbnail-picker-status');
            const closeThumbnailPickerButton = document.getElementById('close-thumbnail-picker');
            const metadataPicker = document.getElementById('metadata-picker');
            const metadataPickerGrid = document.getElementById('metadata-picker-grid');
            const metadataPickerStatus = document.getElementById('metadata-picker-status');
            const closeMetadataPickerButton = document.getElementById('close-metadata-picker');
            const clearMetadataLockButton = document.getElementById('clear-metadata-lock');

            let currentContextMenuFile = null;
            let currentPath = '';
            let searchTimer = null;
            let searchAssistSwapTimer = null;
            const overlayHideTimers = new WeakMap();
            const homepageCategoryOrder = ['Series', 'Anime', 'Movies'];
            const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
            let currentSearchQuery = '';
            let activeSearchAssistIndex = -1;
            let currentView = 'home';
            let homepageRequestId = 0;
            let directoryRequestId = 0;
            let searchRequestId = 0;
            let deferredInstallPrompt = null;
            let showFolderBulkActions = false;
            let showMetadataOverflowActions = false;
            const favoritesKey = 'tv-favorites';
            const recentSearchesKey = 'tv-recent-searches';
            const installDisplayModeQuery = window.matchMedia ? window.matchMedia('(display-mode: standalone)') : null;
            const isStandaloneApp = () => (installDisplayModeQuery?.matches ?? false) || window.navigator.standalone === true;
            const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
            const positionFloatingMenu = (menu, pageX, pageY) => {
                if (!menu) {
                    return;
                }
                const viewportPadding = 8;
                menu.style.display = 'block';
                const menuWidth = menu.offsetWidth || 200;
                const menuHeight = menu.offsetHeight || 100;
                const minLeft = window.scrollX + viewportPadding;
                const maxLeft = window.scrollX + window.innerWidth - menuWidth - viewportPadding;
                const minTop = window.scrollY + viewportPadding;
                const maxTop = window.scrollY + window.innerHeight - menuHeight - viewportPadding;
                const safeLeft = Math.max(minLeft, Math.min(pageX, maxLeft));
                const safeTop = Math.max(minTop, Math.min(pageY, maxTop));
                menu.style.left = `${safeLeft}px`;
                menu.style.top = `${safeTop}px`;
            };
            const updateInstallButton = () => {
                if (!installAppButton) {
                    return;
                }
                installAppButton.hidden = !deferredInstallPrompt || isStandaloneApp();
            };
            const cleanEpisodeTitle = (value) => value
                .replace(/\.[^.]+$/, '')
                .replace(/[._]+/g, ' ')
                .replace(/\bS\d{1,2}E\d{1,2}\b/ig, ' ')
                .replace(/\b\d{1,2}x\d{1,2}\b/ig, ' ')
                .replace(/\b(2160p|1080p|720p|480p|amzn|web[ -]?dl|webrip|bluray|brrip|ddp\d(?:[ .]\d)?|dd\d(?:[ .]\d)?|aac(?:[ .]?\d(?:[ .]\d)?)?|h[ .]?264|h[ .]?265|x264|x265|hevc|proper|repack|nf|dsnp|max|atvp|flux|rawr)\b/ig, ' ')
                .replace(/[\[\]\(\)-]+/g, ' ')
                .replace(/\b\d\b$/g, ' ')
                .replace(/\b[h]\b$/ig, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            const formatEpisodeTitle = (fileName) => {
                const baseName = fileName.replace(/\.[^.]+$/, '').trim();
                const episodeMatch = baseName.match(/S(\d{1,2})E(\d{1,2})/i) || baseName.match(/(\d{1,2})x(\d{1,2})/i);
                const cleanedTitle = cleanEpisodeTitle(baseName);

                if (!episodeMatch) {
                    return cleanedTitle || fileName;
                }

                const episodeNumber = Number.parseInt(episodeMatch[2], 10);
                return cleanedTitle ? `Episode ${episodeNumber}: ${cleanedTitle}` : `Episode ${episodeNumber}`;
            };
            const inferDirectoryKind = (name = '') => {
                const normalized = String(name).trim();
                if (/(season|seizoen)\s*\d+/i.test(normalized) || /\b(?:s|book|part|volume|vol)\s*\d+\b/i.test(normalized)) {
                    return 'Season';
                }
                return 'Folder';
            };
            const extractSortNumbers = (value = '') => {
                const normalized = String(value);
                const seasonEpisodeMatch = normalized.match(/s(\d{1,3})e(\d{1,3})/i) || normalized.match(/(\d{1,3})x(\d{1,3})/i);
                if (seasonEpisodeMatch) {
                    return {
                        season: Number.parseInt(seasonEpisodeMatch[1], 10),
                        episode: Number.parseInt(seasonEpisodeMatch[2], 10)
                    };
                }
                const seasonMatch = normalized.match(/(?:season|seizoen|book|part|volume|vol|s)\s*(\d{1,3})/i);
                if (seasonMatch) {
                    return {
                        season: Number.parseInt(seasonMatch[1], 10),
                        episode: null
                    };
                }
                const standaloneNumber = normalized.match(/\b(\d{1,3})\b/);
                return {
                    season: standaloneNumber ? Number.parseInt(standaloneNumber[1], 10) : null,
                    episode: null
                };
            };
            const compareDirectories = (left, right) => {
                const leftKind = inferDirectoryKind(left.name);
                const rightKind = inferDirectoryKind(right.name);
                if (leftKind !== rightKind) {
                    return leftKind === 'Season' ? -1 : 1;
                }
                const leftNumbers = extractSortNumbers(left.name);
                const rightNumbers = extractSortNumbers(right.name);
                if (leftNumbers.season !== null && rightNumbers.season !== null && leftNumbers.season !== rightNumbers.season) {
                    return leftNumbers.season - rightNumbers.season;
                }
                if (leftNumbers.season !== null && rightNumbers.season === null) {
                    return -1;
                }
                if (leftNumbers.season === null && rightNumbers.season !== null) {
                    return 1;
                }
                return collator.compare(left.name, right.name);
            };
            const compareFiles = (left, right) => {
                const leftNumbers = extractSortNumbers(left.name);
                const rightNumbers = extractSortNumbers(right.name);
                if (leftNumbers.season !== null && rightNumbers.season !== null && leftNumbers.season !== rightNumbers.season) {
                    return leftNumbers.season - rightNumbers.season;
                }
                if (leftNumbers.episode !== null && rightNumbers.episode !== null && leftNumbers.episode !== rightNumbers.episode) {
                    return leftNumbers.episode - rightNumbers.episode;
                }
                if (leftNumbers.episode !== null && rightNumbers.episode === null) {
                    return -1;
                }
                if (leftNumbers.episode === null && rightNumbers.episode !== null) {
                    return 1;
                }
                return collator.compare(left.name, right.name);
            };
            const createDirectorySection = (title, note, extraClass = '') => {
                const section = document.createElement('section');
                section.className = `directory-section ${extraClass}`.trim();

                const header = document.createElement('div');
                header.className = 'directory-section-header';
                header.innerHTML = `
                    <div class="directory-section-title">${title}</div>
                    <div class="directory-section-note">${note}</div>
                `;

                const grid = document.createElement('div');
                grid.className = 'item-grid directory-subgrid';
                section.append(header, grid);
                return { section, grid };
            };
            const createDirectoryGridCard = (dir) => {
                const kind = inferDirectoryKind(dir.name);
                const card = document.createElement('a');
                card.href = `/?path=${encodeURIComponent(dir.url)}`;
                card.className = 'card directory-card';

                const previewContent = dir.posterUrl
                    ? `<img src="${dir.posterUrl}" alt="${dir.name}" class="card-preview-image" onerror="this.style.display='none'; this.parentElement.insertAdjacentHTML('beforeend', '${folderIcon}');">`
                    : folderIcon;

                let metaHTML = '';
                if (dir.rating && dir.rating > 0) {
                    metaHTML = `<div class="card-meta rating">${starIcon}<span>${dir.rating.toFixed(1)}</span></div>`;
                } else if (dir.year) {
                    metaHTML = `<div class="card-meta year">${dir.year}</div>`;
                } else {
                    metaHTML = `<div class="card-meta"><span>${kind}</span></div>`;
                }

                card.innerHTML = `
                    <div class="card-preview">
                        ${previewContent}
                        <div class="card-kind-badge folder">${kind}</div>
                    </div>
                    <div class="card-info">
                        <div class="card-secondary-label">${kind === 'Season' ? 'Season Folder' : 'Subfolder'}</div>
                        <div class="title" title="${dir.name}">${dir.name}</div>
                        ${metaHTML}
                    </div>`;

                attachFavoriteButton(card, {
                    name: dir.name,
                    url: dir.url,
                    posterUrl: dir.posterUrl || null,
                    type: 'directory'
                });
                return card;
            };
            const createFileGridCard = (file) => {
                const card = document.createElement('a');
                card.href = `player.html?video=${encodeURIComponent(file.url)}`;
                card.className = 'card file-card';
                card.dataset.fileUrl = file.url;
                card.dataset.duration = file.durationSeconds;

                const previewContent = file.thumbnailUrl
                    ? `<img src="${file.thumbnailUrl}" alt="${file.name}" class="card-preview-image" onerror="this.parentElement.innerHTML = '${fileIcon}';">`
                    : fileIcon;

                const progressPercentage = (file.progress && file.durationSeconds)
                    ? (file.progress / file.durationSeconds) * 100
                    : 0;

                const metaHTML = `<div class="card-meta"><span>${file.duration}</span></div>`;

                let overlayContent = '';
                if (progressPercentage >= 95) {
                    overlayContent = `<div class="watched-icon"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg></div>`;
                } else if (progressPercentage > 1) {
                    overlayContent = `<div class="progress-bar-container" style="position: absolute; bottom: 0; left: 0; right: 0; height: 4px; background-color: rgba(0,0,0,0.5);"><div class="progress-bar" style="height:100%; width: ${progressPercentage}%; background-color: #DC2626;"></div></div>`;
                }

                card.innerHTML = `
                    <div class="card-preview">
                        ${previewContent}
                        ${overlayContent}
                    </div>
                    <div class="card-info">
                        <div class="title" title="${formatEpisodeTitle(file.name)}">${formatEpisodeTitle(file.name)}</div>
                        ${metaHTML}
                    </div>`;

                attachFavoriteButton(card, file);
                card.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    currentContextMenuFile = file.url;
                    positionFloatingMenu(contextMenu, e.pageX, e.pageY);
                });
                return card;
            };

            const starIcon = `<svg fill="currentColor" viewBox="0 0 20 20" width="14" height="14" style="color: #FBBF24;"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"></path></svg>`;
            const favoriteIcon = `<svg fill="currentColor" viewBox="0 0 20 20" width="14" height="14"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"></path></svg>`;
            const folderIcon = `<svg class='card-preview-icon' fill='none' stroke='currentColor' viewBox='0 0 24 24'><path stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z'></path></svg>`;
            const fileIcon = `<svg class='card-preview-icon' fill='none' stroke='currentColor' viewBox='0 0 24 24'><path stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z'></path><path stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M21 12a9 9 0 11-18 0 9 9 0 0118 0z'></path></svg>`;
            const getFavorites = () => {
                try {
                    return JSON.parse(localStorage.getItem(favoritesKey) || '[]');
                } catch {
                    return [];
                }
            };
            const getRecentSearches = () => {
                try {
                    const parsed = JSON.parse(localStorage.getItem(recentSearchesKey) || '[]');
                    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string' && item.trim().length >= 2) : [];
                } catch {
                    return [];
                }
            };
            const saveRecentSearches = (entries) => {
                localStorage.setItem(recentSearchesKey, JSON.stringify(entries.slice(0, 8)));
            };
            const clearRecentSearches = () => {
                localStorage.removeItem(recentSearchesKey);
            };
            const escapeHtml = (value = '') => value
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
            const highlightSearchMatch = (value, query) => {
                const safeValue = escapeHtml(value);
                const normalizedQuery = query.trim();
                if (!normalizedQuery) {
                    return safeValue;
                }
                const escapedQuery = normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return safeValue.replace(new RegExp(`(${escapedQuery})`, 'ig'), '<mark class="search-highlight">$1</mark>');
            };
            const rememberSearch = (query) => {
                if (!query || query.length < 2) {
                    return;
                }
                const normalized = query.trim();
                const nextEntries = [normalized, ...getRecentSearches().filter(item => item.toLowerCase() !== normalized.toLowerCase())];
                saveRecentSearches(nextEntries);
            };
            const setActiveSearchAssistChip = (nextIndex) => {
                if (!searchAssist) {
                    return;
                }
                const chips = [...searchAssist.querySelectorAll('[data-search-query]')];
                if (chips.length === 0) {
                    activeSearchAssistIndex = -1;
                    return;
                }
                activeSearchAssistIndex = ((nextIndex % chips.length) + chips.length) % chips.length;
                chips.forEach((chip, index) => chip.classList.toggle('is-active', index === activeSearchAssistIndex));
                chips[activeSearchAssistIndex].focus();
            };
            const createSearchAssistChip = ({ label, query = '', meta = false, secondary = false, action = '', title = '' }) => {
                const element = document.createElement(query || action ? 'button' : 'span');
                element.className = 'search-chip';
                if (meta) {
                    element.classList.add('meta');
                }
                if (secondary) {
                    element.classList.add('secondary');
                }
                if (action) {
                    element.classList.add('action');
                    element.dataset.searchAction = action;
                }
                if (query) {
                    element.dataset.searchQuery = query;
                }
                if (query || action) {
                    element.type = 'button';
                }
                if (title) {
                    element.title = title;
                }
                element.textContent = label;
                return element;
            };
            const swapSearchAssistContent = (nextNodes) => {
                if (!searchAssist) {
                    return;
                }
                const apply = () => {
                    searchAssist.innerHTML = '';
                    nextNodes.forEach((node) => searchAssist.appendChild(node));
                    searchAssist.classList.toggle('is-empty', nextNodes.length === 0);
                    searchAssist.classList.remove('is-transitioning');
                };
                clearTimeout(searchAssistSwapTimer);
                if (prefersReducedMotion || searchAssist.children.length === 0) {
                    apply();
                    return;
                }
                searchAssist.classList.add('is-transitioning');
                [...searchAssist.children].forEach((child) => child.classList.add('is-leaving'));
                searchAssistSwapTimer = window.setTimeout(apply, 120);
            };
            const renderSearchAssist = ({ query = '', resultCount = null } = {}) => {
                if (!searchAssist) {
                    return;
                }
                activeSearchAssistIndex = -1;
                const normalizedQuery = query.trim();
                const recent = getRecentSearches();
                const nextNodes = [];
                if (normalizedQuery.length >= 2) {
                    const resultLabel = resultCount === null
                        ? 'Searching library...'
                        : `${resultCount} ${resultCount === 1 ? 'result' : 'results'}`;
                    nextNodes.push(createSearchAssistChip({ label: resultLabel, meta: true }));
                    const relatedRecent = recent
                        .filter((item) => item.toLowerCase() !== normalizedQuery.toLowerCase())
                        .slice(0, 4);
                    if (relatedRecent.length > 0) {
                        relatedRecent.forEach((item) => {
                            nextNodes.push(createSearchAssistChip({
                                label: item,
                                query: item,
                                title: `Search again for ${item}`
                            }));
                        });
                    } else {
                        nextNodes.push(createSearchAssistChip({
                            label: 'Press Enter to search',
                            meta: true,
                            secondary: true
                        }));
                    }
                } else if (recent.length > 0) {
                    nextNodes.push(createSearchAssistChip({ label: 'Recent searches', meta: true }));
                    recent.slice(0, 5).forEach((item) => {
                        nextNodes.push(createSearchAssistChip({
                            label: item,
                            query: item,
                            title: `Repeat search for ${item}`
                        }));
                    });
                    nextNodes.push(createSearchAssistChip({
                        label: 'Clear history',
                        action: 'clear-history',
                        secondary: true,
                        title: 'Remove recent searches'
                    }));
                } else if (document.activeElement === searchInput) {
                    nextNodes.push(createSearchAssistChip({
                        label: 'Type at least 2 letters to search',
                        meta: true,
                        secondary: true
                    }));
                }
                swapSearchAssistContent(nextNodes);
            };

            const setSearchVisibility = (visible) => {
                if (searchStack) {
                    searchStack.style.display = visible ? '' : 'none';
                }
                if (!visible && searchAssist) {
                    clearTimeout(searchAssistSwapTimer);
                    searchAssist.innerHTML = '';
                    searchAssist.classList.add('is-empty');
                }
            };
            const updatePageContext = () => {
                if (!pageContext) {
                    return;
                }
                const breadcrumbVisible = breadcrumb && breadcrumb.style.display !== 'none' && breadcrumb.textContent.trim().length > 0;
                const menuVisible = folderOptionsButton && folderOptionsButton.style.display !== 'none';
                pageContext.style.display = breadcrumbVisible || menuVisible ? 'flex' : 'none';
            };
            const updateOverflowMenu = () => {
                const showMenu = showFolderBulkActions || showMetadataOverflowActions;
                folderOptionsButton.style.display = showMenu ? 'inline-flex' : 'none';
                folderOptionsButton.title = showMetadataOverflowActions ? 'Series Options' : 'Folder Options';
                if (refreshMetadataMenuButton) {
                    refreshMetadataMenuButton.hidden = !showMetadataOverflowActions;
                }
                if (changeMetadataMenuButton) {
                    changeMetadataMenuButton.hidden = !showMetadataOverflowActions;
                }
                if (changeThumbnailMenuButton) {
                    changeThumbnailMenuButton.hidden = !showMetadataOverflowActions;
                }
                if (markAllWatchedMenuButton) {
                    markAllWatchedMenuButton.hidden = !showFolderBulkActions;
                }
                if (markAllUnwatchedMenuButton) {
                    markAllUnwatchedMenuButton.hidden = !showFolderBulkActions;
                }
                if (!showMenu) {
                    folderOptionsMenu.style.display = 'none';
                }
                updatePageContext();
            };
            const saveFavorites = (favorites) => localStorage.setItem(favoritesKey, JSON.stringify(favorites));
            const isFavorite = (url) => getFavorites().some(item => item.url === url);
            const toggleFavoriteEntry = (item) => {
                const favorites = getFavorites();
                const existingIndex = favorites.findIndex(entry => entry.url === item.url);
                if (existingIndex >= 0) {
                    favorites.splice(existingIndex, 1);
                } else {
                    favorites.unshift(item);
                }
                saveFavorites(favorites.slice(0, 50));
                renderFavoritesRow();
                document.querySelectorAll(`[data-favorite-url="${item.url}"]`).forEach(button => {
                    button.classList.toggle('active', isFavorite(item.url));
                });
            };
            const createFavoriteEntry = (item) => ({
                name: item.name,
                url: item.url,
                thumbnailUrl: item.thumbnailUrl || null,
                posterUrl: item.posterUrl || null,
                duration: item.duration || 'Unknown',
                durationSeconds: item.durationSeconds || 0,
                progress: item.progress || 0,
                seasonNumber: item.seasonNumber || null,
                episodeNumber: item.episodeNumber || null,
                episodeName: item.episodeName || null,
                seriesPath: item.seriesPath || '',
                type: item.type || 'file'
            });
            const attachFavoriteButton = (card, item) => {
                if (!item?.url) {
                    return;
                }
                const preview = card.querySelector('.card-preview');
                if (!preview) {
                    return;
                }
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'favorite-toggle';
                button.dataset.favoriteUrl = item.url;
                button.title = 'Add to favorites';
                button.innerHTML = favoriteIcon;
                button.classList.toggle('active', isFavorite(item.url));
                button.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleFavoriteEntry(createFavoriteEntry(item));
                    button.classList.toggle('active', isFavorite(item.url));
                });
                preview.appendChild(button);
            };
            const getMetadataPathForCurrentView = () => currentPath.split('/').slice(-1)[0].toLowerCase().startsWith('season ')
                ? currentPath.split('/').slice(0, -1).join('/')
                : currentPath;
            const stageHomeSection = (element, order = 0) => {
                if (!element || prefersReducedMotion) {
                    return;
                }
                element.classList.remove('motion-enter');
                element.style.setProperty('--row-delay', `${order * 70}ms`);
                element.classList.add('motion-enter');
                window.setTimeout(() => {
                    element.classList.remove('motion-enter');
                }, 820 + (order * 70));
            };
            const enhanceScrollerMotion = (scroller) => {
                if (!scroller || prefersReducedMotion) {
                    return;
                }
                const wrapper = scroller.closest('.row-wrapper');
                const cards = [...scroller.querySelectorAll('.card')];
                if (cards.length === 0) {
                    return;
                }
                let frameId = 0;
                const schedule = () => {
                    if (frameId) {
                        return;
                    }
                    frameId = window.requestAnimationFrame(() => {
                        frameId = 0;
                        const scrollerRect = scroller.getBoundingClientRect();
                        const scrollerCenter = scrollerRect.left + (scrollerRect.width / 2);
                        const scrollRange = Math.max(1, scroller.scrollWidth - scroller.clientWidth);
                        const spotlight = 8 + ((scroller.scrollLeft / scrollRange) * 84);
                        wrapper?.style.setProperty('--row-spotlight', `${spotlight}%`);
                        cards.forEach((card) => {
                            const cardRect = card.getBoundingClientRect();
                            const cardCenter = cardRect.left + (cardRect.width / 2);
                            const relativeDistance = (cardCenter - scrollerCenter) / Math.max(1, scrollerRect.width * 0.5);
                            const clamped = Math.max(-1, Math.min(1, relativeDistance));
                            const focus = 1 - Math.min(1, Math.abs(clamped));
                            card.style.setProperty('--card-depth-y', `${(-focus * 4).toFixed(2)}px`);
                            card.style.setProperty('--card-image-pan', `${(-clamped * 6).toFixed(2)}px`);
                        });
                    });
                };
                const setDragging = (active) => {
                    scroller.classList.toggle('is-dragging', active);
                    wrapper?.classList.toggle('is-interacting', active || scroller.scrollLeft > 0);
                };
                scroller.addEventListener('scroll', schedule, { passive: true });
                scroller.addEventListener('pointerdown', () => setDragging(true));
                scroller.addEventListener('pointerup', () => setDragging(false));
                scroller.addEventListener('pointercancel', () => setDragging(false));
                scroller.addEventListener('pointerleave', () => setDragging(false));
                if ('ResizeObserver' in window) {
                    const observer = new ResizeObserver(() => schedule());
                    observer.observe(scroller);
                } else {
                    window.addEventListener('resize', schedule);
                }
                schedule();
            };
            const openPickerOverlay = (overlay) => {
                if (!overlay) {
                    return;
                }
                const pendingTimer = overlayHideTimers.get(overlay);
                if (pendingTimer) {
                    clearTimeout(pendingTimer);
                    overlayHideTimers.delete(overlay);
                }
                overlay.style.display = 'flex';
                if (prefersReducedMotion) {
                    overlay.classList.add('is-open');
                    return;
                }
                window.requestAnimationFrame(() => {
                    overlay.classList.add('is-open');
                });
            };
            const closePickerOverlay = (overlay, grid) => {
                if (!overlay) {
                    return;
                }
                overlay.classList.remove('is-open');
                const completeClose = () => {
                    overlay.style.display = 'none';
                    if (grid) {
                        grid.innerHTML = '';
                    }
                };
                if (prefersReducedMotion) {
                    completeClose();
                    return;
                }
                const timer = window.setTimeout(() => {
                    overlayHideTimers.delete(overlay);
                    completeClose();
                }, 220);
                overlayHideTimers.set(overlay, timer);
            };

            /**
             * Creates a card for a video or a directory.
             * This function is used by the new homepage rows.
             */
            function createItemCard(item, options = {}) {
                const isDirectory = item.type === 'directory';
                const isContinueWatching = options.isContinueWatching;
                
                // For continue watching items with series info, create a div instead of link
                const card = document.createElement(isContinueWatching && item.seriesPath ? 'div' : 'a');
                card.className = 'card';
                
                if (!isContinueWatching || !item.seriesPath) {
                    card.href = isDirectory 
                        ? `/?path=${encodeURIComponent(item.url)}`
                        : `player.html?video=${encodeURIComponent(item.url)}`;
                }
                
                if (!isDirectory) {
                    card.dataset.fileUrl = item.url;
                    card.dataset.duration = item.durationSeconds;
                    card.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        currentContextMenuFile = item.url;
                        positionFloatingMenu(contextMenu, e.pageX, e.pageY);
                    });
                }

                const imageUrl = isDirectory ? item.posterUrl : item.thumbnailUrl;
                const fallbackIcon = isDirectory ? folderIcon : fileIcon;

                const previewContent = imageUrl
                    ? `<img src="${imageUrl}" alt="${item.name}" class="card-preview-image" loading="lazy" decoding="async" draggable="false" onerror="this.style.display='none'; this.parentElement.insertAdjacentHTML('beforeend', '${fallbackIcon}');">`
                    : fallbackIcon;
                
                const progressPercentage = (item.progress && item.durationSeconds) 
                    ? (item.progress / item.durationSeconds) * 100 
                    : 0;

                let metaHTML = '';
                if (item.seasonNumber && item.episodeNumber) {
                     const cleanedEpisodeTitle = item.episodeName
                        ? cleanEpisodeTitle(item.episodeName)
                        : '';
                     const formattedEpisodeTitle = cleanedEpisodeTitle || `Episode ${item.episodeNumber}`;
                     metaHTML = `
                        <div class="episode-title" title="${formattedEpisodeTitle}">${formattedEpisodeTitle}</div>
                        <div class="season-episode-info">S${item.seasonNumber} | E${item.episodeNumber}</div>
                    `;
                } else if (item.rating && item.rating > 0) {
                    metaHTML = `<div class="card-meta rating">${starIcon}<span>${item.rating.toFixed(1)}</span></div>`;
                } else if (item.year) {
                    metaHTML = `<div class="card-meta year">${item.year}</div>`;
                } else {
                    metaHTML = `<div class="card-meta">&nbsp;</div>`;
                }

                let overlayContent = '';
                if (progressPercentage >= 95) {
                    overlayContent = `<div class="watched-icon"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg></div>`;
                } else if (progressPercentage > 1) {
                    overlayContent = `<div class="progress-bar-container"><div class="progress-bar" style="width: ${progressPercentage}%"></div></div>`;
                }

                // Special handling for continue watching items with series info
                if (options.isContinueWatching && item.seriesPath) {
                    card.innerHTML = `
                        <a href="player.html?video=${encodeURIComponent(item.url)}" class="card-preview-link">
                            <div class="card-preview">
                                ${previewContent}
                                ${overlayContent}
                            </div>
                        </a>
                        <div class="card-info">
                            <a href="/?path=${encodeURIComponent(item.seriesPath)}" class="title series-title-link" title="Go to ${item.name} overview">${item.name}</a>
                            ${metaHTML}
                        </div>
                    `;
                } else {
                    card.innerHTML = `
                        <div class="card-preview">
                            ${previewContent}
                            ${overlayContent}
                        </div>
                        <div class="card-info">
                            <div class="title" title="${item.name}">${item.name}</div>
                            ${metaHTML}
                        </div>
                    `;
                }

                if (options.isContinueWatching) {
                    const removeButton = document.createElement('button');
                    removeButton.className = 'remove-from-continue';
                    removeButton.title = item.seriesPath
                        ? 'Remove series from Continue Watching'
                        : 'Remove from Continue Watching';
                    removeButton.innerHTML = `<svg fill="currentColor" viewBox="0 0 20 20" width="12" height="12"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"></path></svg>`;
                    
                    removeButton.addEventListener('click', async (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (removeButton.disabled) {
                            return;
                        }
                        removeButton.disabled = true;
                        try {
                            if (item.seriesPath) {
                                if (!window.confirm(`Remove "${item.name}" from Continue Watching? This resets progress for the full series.`)) {
                                    return;
                                }
                                status.textContent = 'Removing series from Continue Watching...';
                                const response = await fetch('/api/continue-watching/series-action', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        seriesPath: item.seriesPath,
                                        action: 'mark-unwatched'
                                    })
                                });
                                if (!response.ok) {
                                    throw new Error(`Server error: ${response.statusText}`);
                                }
                                await loadRecentlyWatched();
                                status.textContent = '';
                                return;
                            }

                            socket.emit('markVideo', { videoFile: item.url, watched: false });
                        } catch (error) {
                            console.error('Failed to remove continue watching item:', error);
                            status.textContent = `Error: ${error.message}`;
                        } finally {
                            removeButton.disabled = false;
                        }
                    });
                    
                    // For continue watching items with series path, the preview is inside a link
                    const previewElement = item.seriesPath 
                        ? card.querySelector('.card-preview-link .card-preview')
                        : card.querySelector('.card-preview');
                    
                    if (previewElement) {
                        previewElement.appendChild(removeButton);
                    }
                }

                if (item?.url) {
                    attachFavoriteButton(card, item);
                }

                return card;
            }

            /**
             * Creates and manages a horizontal scrolling row for a category.
             */
            function createCategoryRow(title, items, container, options = {}) {
                if (!items || items.length === 0) return;

                container.innerHTML = ''; // Clear container
                container.classList.toggle('continue-watching-section', title === 'Continue Watching');

                const isContinueWatching = title === 'Continue Watching';
                const isStaticTitle = options.isStaticTitle || title === 'Favorites' || title === 'Search Results';

                const titleContainer = document.createElement('div');
                titleContainer.className = 'category-title-container';
                
                const titleEl = document.createElement((isContinueWatching || isStaticTitle) ? 'h2' : 'a');
                titleEl.className = 'category-title';

                if (isContinueWatching || isStaticTitle) {
                    titleEl.textContent = title;
                } else {
                    titleEl.href = `/?path=${encodeURIComponent(title)}`;
                    titleEl.innerHTML = `<span>${title}</span><svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" style="margin-left: 0.5rem; opacity: 0; transition: all 0.2s ease;"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>`;
                }
                
                const arrowsContainer = document.createElement('div');
                arrowsContainer.className = 'scroll-arrows';
                const actionsContainer = document.createElement('div');
                actionsContainer.className = 'category-actions';

                const wrapper = document.createElement('div');
                wrapper.className = 'row-wrapper';

                const scroller = document.createElement('div');
                scroller.className = 'items-scroller';

                items.forEach((item, index) => {
                    const card = createItemCard(item, { isContinueWatching });
                    if (!prefersReducedMotion) {
                        card.style.setProperty('--card-delay', `${Math.min(index, 7) * 38}ms`);
                    }
                    scroller.appendChild(card);
                });

                // Re-calculate the number of items per view based on the current window width.
                const getItemsPerView = () => {
                    const width = window.innerWidth;
                    if (width <= 400) return 1;
                    if (width <= 600) return 2;
                    if (width <= 900) return 3;
                    if (width <= 1200) return 4;
                    if (width <= 1400) return 5;
                    return 6;
                }
                
                // Only show arrows if content overflows
                const showArrows = items.length > getItemsPerView();
                 if (showArrows) {
                    const prevArrow = document.createElement('button');
                    prevArrow.className = 'scroll-arrow';
                    prevArrow.innerHTML = `<svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" /></svg>`;
                    
                    const nextArrow = document.createElement('button');
                    nextArrow.className = 'scroll-arrow';
                    nextArrow.innerHTML = `<svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>`;

                    const updateArrowState = () => {
                        const scrollLeft = Math.round(scroller.scrollLeft);
                        const clientWidth = Math.round(scroller.clientWidth);
                        const scrollWidth = Math.round(scroller.scrollWidth);
                        prevArrow.classList.toggle('disabled', scrollLeft <= 0);
                        nextArrow.classList.toggle('disabled', scrollLeft + clientWidth >= scrollWidth - 10);
                    };

                    const getItemsPerPage = () => {
                        const card = scroller.querySelector('.card');
                        if (!card) return 1;
                        const scrollerWidth = scroller.clientWidth;
                        const gap = parseFloat(window.getComputedStyle(scroller).gap) || 0;
                        // We calculate the full width of a card including half a gap on each side for an average.
                        // Then we see how many of those fit in the scroller.
                        const effectiveCardWidth = card.offsetWidth + gap;
                        if (effectiveCardWidth === 0) return 1;
                        // Return at least 1 to prevent division by zero and ensure scrolling is always possible.
                        return Math.max(1, Math.floor(scrollerWidth / effectiveCardWidth));
                    };

                    prevArrow.onclick = () => {
                        scroller.scrollBy({ left: -scroller.clientWidth, behavior: 'smooth' });
                    };

                    nextArrow.onclick = () => {
                        scroller.scrollBy({ left: scroller.clientWidth, behavior: 'smooth' });
                    };
                    
                    scroller.addEventListener('scroll', updateArrowState);

                    arrowsContainer.append(prevArrow, nextArrow);
                    actionsContainer.append(arrowsContainer);
                    
                    // Initial state update after render
                    setTimeout(updateArrowState, 100);
                    if ('ResizeObserver' in window) {
                        const resizeObserver = new ResizeObserver(() => updateArrowState());
                        resizeObserver.observe(scroller);
                    } else {
                        window.addEventListener('resize', updateArrowState);
                    }
                }

                if (actionsContainer.children.length > 0) {
                    titleContainer.append(titleEl, actionsContainer);
                } else {
                    titleContainer.append(titleEl);
                }

                wrapper.appendChild(scroller);
                container.append(titleContainer, wrapper);
                container.style.display = 'block';
                enhanceScrollerMotion(scroller);
                if (!prefersReducedMotion) {
                    container.classList.add('motion-enter');
                    const rowDelay = Math.max(0, Number(options.motionOrder) || 0) * 55;
                    container.style.setProperty('--row-delay', `${rowDelay}ms`);
                    window.setTimeout(() => {
                        container.classList.remove('motion-enter');
                    }, rowDelay + 760);
                }
            }
            
            async function loadHomepage() {
                const requestId = ++homepageRequestId;
                currentView = 'home';
                // Configure view
                homepageRowsContainer.style.display = 'block';
                continueWatchingRow.style.display = 'block';
                favoritesRow.style.display = 'block';
                folderViewContainer.style.display = 'none';
                seriesHeaderWrapper.style.display = 'none';
                breadcrumb.style.display = 'none';
                showFolderBulkActions = false;
                showMetadataOverflowActions = false;
                updateOverflowMenu();
                updatePageContext();
                document.querySelector('.app-menu .app-menu-brand').style.display = 'block';
                setSearchVisibility(true);

                // Load data
                await loadRecentlyWatched(1);
                renderFavoritesRow(2);
                pageContext?.classList.remove('is-staged');
                if (!prefersReducedMotion) {
                    window.requestAnimationFrame(() => pageContext?.classList.add('is-staged'));
                }
                
                try {
                    status.textContent = 'Loading library...';
                    const response = await fetch('/api/homepage-content');
                    if (!response.ok) throw new Error(`Server error: ${response.statusText}`);
                    const data = await response.json();
                    if (requestId !== homepageRequestId || currentView !== 'home') {
                        return;
                    }
                    status.textContent = '';
                    
                    homepageRowsContainer.innerHTML = '';
                    const orderedCategoryNames = Object.keys(data).sort((left, right) => {
                        const leftIndex = homepageCategoryOrder.indexOf(left);
                        const rightIndex = homepageCategoryOrder.indexOf(right);
                        const normalizedLeftIndex = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
                        const normalizedRightIndex = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
                        if (normalizedLeftIndex !== normalizedRightIndex) {
                            return normalizedLeftIndex - normalizedRightIndex;
                        }
                        return left.localeCompare(right);
                    });
                    let sectionOrder = 3;
                    if (continueWatchingRow.style.display === 'none') {
                        sectionOrder -= 1;
                    }
                    if (favoritesRow.style.display === 'none') {
                        sectionOrder -= 1;
                    }
                    for (const categoryName of orderedCategoryNames) {
                        if (data[categoryName].length > 0) {
                            const rowContainer = document.createElement('div');
                            rowContainer.className = 'category-row';
                            homepageRowsContainer.appendChild(rowContainer);
                            createCategoryRow(categoryName, data[categoryName], rowContainer, {
                                motionOrder: sectionOrder
                            });
                            sectionOrder += 1;
                        }
                    }
                } catch (error) {
                    console.error('Failed to load homepage:', error);
                    status.textContent = `Error: ${error.message}`;
                }
            }
            
            async function loadRecentlyWatched(motionOrder = 0) {
                try {
                    const response = await fetch('/api/recently-watched');
                    if (!response.ok) return;
                    const data = await response.json();

                    if (data && data.length > 0) {
                        createCategoryRow('Continue Watching', data, continueWatchingRow, { motionOrder });
                        stageHomeSection(continueWatchingRow, motionOrder);
                    } else {
                        continueWatchingRow.style.display = 'none';
                    }
                } catch (error) {
                    console.error('Failed to load recently watched:', error);
                    continueWatchingRow.style.display = 'none';
                }
            }

            function renderFavoritesRow(motionOrder = 0) {
                const favorites = getFavorites();
                if (favorites.length === 0) {
                    favoritesRow.style.display = 'none';
                    favoritesRow.innerHTML = '';
                    return;
                }

                favoritesRow.style.display = 'block';
                createCategoryRow('Favorites', favorites, favoritesRow, { isStaticTitle: true, motionOrder });
                stageHomeSection(favoritesRow, motionOrder);
            }

            async function loadSearchResults(query) {
                const requestId = ++searchRequestId;
                currentView = 'search';
                homepageRowsContainer.style.display = 'none';
                continueWatchingRow.style.display = 'none';
                favoritesRow.style.display = 'none';
                folderViewContainer.style.display = 'block';
                seriesHeaderWrapper.style.display = 'none';
                showFolderBulkActions = false;
                showMetadataOverflowActions = false;
                updateOverflowMenu();
                document.querySelector('.app-menu .app-menu-brand').style.display = 'block';
                breadcrumb.style.display = 'flex';
                setSearchVisibility(true);
                updatePageContext();
                renderBreadcrumb(`Search/${query}`);
                allVideosGrid.classList.add('episode-view');
                allVideosGrid.innerHTML = '';
                status.textContent = 'Searching...';
                renderSearchAssist({ query, resultCount: null });

                try {
                    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
                    if (!response.ok) throw new Error(`Server error: ${response.statusText}`);
                    const data = await response.json();
                    if (requestId !== searchRequestId || currentView !== 'search' || currentSearchQuery !== query) {
                        return;
                    }
                    const results = Array.isArray(data.results) ? data.results : [];
                    rememberSearch(query);
                    renderSearchAssist({ query, resultCount: results.length });

                    if (results.length === 0) {
                        status.textContent = `No results for "${query}".`;
                        allVideosGrid.innerHTML = '';
                        return;
                    }

                    status.textContent = '';
                    folderViewContainer.style.display = 'block';
                    results.forEach(file => {
                        const card = document.createElement('a');
                        card.href = `player.html?video=${encodeURIComponent(file.url)}`;
                        card.className = 'card file-card';
                        card.dataset.fileUrl = file.url;
                        card.dataset.duration = file.durationSeconds;

                        const previewContent = file.thumbnailUrl
                            ? `<img src="${file.thumbnailUrl}" alt="${file.name}" class="card-preview-image" loading="lazy" decoding="async" onerror="this.parentElement.innerHTML = '${fileIcon}';">`
                            : fileIcon;

                        const progressPercentage = (file.progress && file.durationSeconds)
                            ? (file.progress / file.durationSeconds) * 100
                            : 0;

                        let overlayContent = '';
                        if (progressPercentage >= 95) {
                            overlayContent = `<div class="watched-icon"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg></div>`;
                        } else if (progressPercentage > 1) {
                            overlayContent = `<div class="progress-bar-container" style="position: absolute; bottom: 0; left: 0; right: 0; height: 4px; background-color: rgba(0,0,0,0.5);"><div class="progress-bar" style="height:100%; width: ${progressPercentage}%; background-color: #DC2626;"></div></div>`;
                        }

                        card.innerHTML = `
                            <div class="card-preview">
                                ${previewContent}
                                ${overlayContent}
                            </div>
                            <div class="card-info">
                                <div class="title" title="${formatEpisodeTitle(file.name)}">${highlightSearchMatch(formatEpisodeTitle(file.name), query)}</div>
                                <div class="metadata">${file.duration}</div>
                            </div>`;
                        attachFavoriteButton(card, file);
                        allVideosGrid.appendChild(card);
                    });
                } catch (error) {
                    console.error('Failed to search library:', error);
                    status.textContent = `Error: ${error.message}`;
                }
            }

            /**
             * This function is for the original folder/grid view.
             * It's kept for navigating into folders.
             */
            async function loadDirectory(path = '') {
                const requestId = ++directoryRequestId;
                currentView = 'directory';
                // Configure view
                homepageRowsContainer.style.display = 'none';
                continueWatchingRow.style.display = 'none';
                folderViewContainer.style.display = 'block';
                breadcrumb.style.display = 'flex';
                document.querySelector('.app-menu .app-menu-brand').style.display = 'block';
                showFolderBulkActions = false;
                showMetadataOverflowActions = false;
                updateOverflowMenu();
                setSearchVisibility(true);
                updatePageContext();

                try {
                    allVideosGrid.innerHTML = '';
                    status.textContent = 'Loading...';
                    currentPath = path;

                    const response = await fetch(`/api/videos?path=${encodeURIComponent(path)}`);
                    if (!response.ok) throw new Error(`Server error: ${response.statusText}`);
                    const data = await response.json();
                    if (requestId !== directoryRequestId || currentView !== 'directory') {
                        return;
                    }

                    const sortedDirectories = [...data.directories].sort(compareDirectories);
                    const sortedFiles = [...data.files].sort(compareFiles);

                    allVideosGrid.classList.toggle('episode-view', sortedFiles.length > 0 && sortedDirectories.length === 0);

                    renderBreadcrumb(data.path);
                    renderSeriesHeader(data.tmdbInfo);
                    showMetadataOverflowActions = Boolean(data.tmdbInfo && data.tmdbInfo.name && currentPath);
                    
                    if (sortedFiles && sortedFiles.length > 1) {
                        showFolderBulkActions = true;
                    } else {
                        showFolderBulkActions = false;
                    }
                    updateOverflowMenu();

                    if (sortedDirectories.length === 0 && sortedFiles.length === 0) {
                        status.textContent = 'This folder is empty.';
                    } else {
                        status.textContent = '';
                    }

                    const hasMixedContent = sortedDirectories.length > 0 && sortedFiles.length > 0;
                    allVideosGrid.classList.toggle('mixed-view', hasMixedContent);

                    if (hasMixedContent) {
                        const folderSection = createDirectorySection(
                            'Seasons / Folders',
                            `${sortedDirectories.length} item${sortedDirectories.length === 1 ? '' : 's'}`,
                            'directory-section-folders'
                        );
                        sortedDirectories.forEach(dir => {
                            folderSection.grid.appendChild(createDirectoryGridCard(dir));
                        });
                        allVideosGrid.appendChild(folderSection.section);

                        const fileSection = createDirectorySection(
                            'Episodes / Videos',
                            `${sortedFiles.length} item${sortedFiles.length === 1 ? '' : 's'}`,
                            'directory-section-files'
                        );
                        if (sortedFiles.length > 0) {
                            fileSection.grid.classList.add('episode-view');
                        }
                        sortedFiles.forEach(file => {
                            fileSection.grid.appendChild(createFileGridCard(file));
                        });
                        allVideosGrid.appendChild(fileSection.section);
                    } else {
                        sortedDirectories.forEach(dir => {
                            allVideosGrid.appendChild(createDirectoryGridCard(dir));
                        });

                        sortedFiles.forEach(file => {
                            allVideosGrid.appendChild(createFileGridCard(file));
                        });
                    }

                } catch (error) {
                    console.error('Failed to load directory:', error);
                    status.textContent = `Error: ${error.message}`;
                }
            }

            function renderBreadcrumb(path) {
                breadcrumb.innerHTML = '';
                const homeLink = document.createElement('a');
                homeLink.href = '/';
                homeLink.textContent = 'Library';
                breadcrumb.appendChild(homeLink);

                if (path) {
                    const parts = path.split('/');
                    let cumulativePath = '';
                    parts.forEach((part, index) => {
                        cumulativePath += (index > 0 ? '/' : '') + part;
                        const separator = document.createElement('span');
                        separator.className = 'separator';
                        separator.textContent = '>';
                        breadcrumb.appendChild(separator);

                        const partLink = document.createElement('a');
                        partLink.href = `/?path=${encodeURIComponent(cumulativePath)}`;
                        partLink.textContent = part;
                        breadcrumb.appendChild(partLink);
                    });
                }
                updatePageContext();
            }

            function renderSeriesHeader(tmdbInfo) {
                if (tmdbInfo && tmdbInfo.name) {
                    seriesHeaderWrapper.style.display = 'block';
                    document.getElementById('series-poster').src = tmdbInfo.posterUrl || '';
                    document.getElementById('series-title').textContent = tmdbInfo.name;
                    document.getElementById('series-description').textContent = tmdbInfo.description || 'No description available.';
                    
                    const ratingEl = document.querySelector('#series-details .rating');
                    if (tmdbInfo.rating && tmdbInfo.rating > 0) {
                        document.getElementById('series-rating').textContent = tmdbInfo.rating.toFixed(1);
                        ratingEl.style.display = 'flex';
                    } else {
                        ratingEl.style.display = 'none';
                    }

                    if (tmdbInfo.backdropUrl) {
                        document.getElementById('series-backdrop').style.backgroundImage = `url('${tmdbInfo.backdropUrl}')`;
                    } else {
                        document.getElementById('series-backdrop').style.backgroundImage = 'none';
                    }

                } else {
                    seriesHeaderWrapper.style.display = 'none';
                }
            }

            function closeThumbnailPicker() {
                closePickerOverlay(thumbnailPicker, thumbnailPickerGrid);
            }

            function closeMetadataPicker() {
                closePickerOverlay(metadataPicker, metadataPickerGrid);
            }

            async function openThumbnailPicker() {
                if (!currentPath) {
                    return;
                }

                const normalizedPath = getMetadataPathForCurrentView();

                openPickerOverlay(thumbnailPicker);
                thumbnailPickerStatus.textContent = 'Loading thumbnail options...';
                thumbnailPickerGrid.innerHTML = '';

                try {
                    const response = await fetch(`/api/thumbnail-options?path=${encodeURIComponent(normalizedPath)}`);
                    if (!response.ok) {
                        throw new Error(`Server error: ${response.statusText}`);
                    }
                    const data = await response.json();
                    const currentUrl = data.currentSelection?.url || '';
                    thumbnailPickerStatus.textContent = 'Choose the thumbnail that should represent this series.';

                    data.candidates.forEach((candidate) => {
                        const button = document.createElement('button');
                        button.type = 'button';
                        button.className = 'thumbnail-option';
                        button.style.setProperty('--picker-delay', `${Math.min(thumbnailPickerGrid.children.length, 7) * 35}ms`);
                        if (candidate.url === currentUrl) {
                            button.classList.add('active');
                        }
                        button.innerHTML = `
                            <img src="${candidate.url}" alt="${candidate.label}">
                            <div class="thumbnail-option-body">
                                <div class="thumbnail-option-label">${candidate.label}</div>
                                <div class="thumbnail-option-source">${candidate.source}</div>
                            </div>
                        `;
                        button.addEventListener('click', async () => {
                            try {
                                thumbnailPickerStatus.textContent = 'Saving thumbnail...';
                                const saveResponse = await fetch('/api/thumbnail-selection', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        path: normalizedPath,
                                        selectedUrl: candidate.url,
                                        selectedLabel: candidate.label,
                                        selectedSource: candidate.source
                                    })
                                });
                                if (!saveResponse.ok) {
                                    throw new Error(`Server error: ${saveResponse.statusText}`);
                                }
                                closeThumbnailPicker();
                                await loadDirectory(currentPath);
                            } catch (error) {
                                console.error('Failed to save thumbnail selection:', error);
                                thumbnailPickerStatus.textContent = `Error: ${error.message}`;
                            }
                        });
                        thumbnailPickerGrid.appendChild(button);
                    });
                } catch (error) {
                    console.error('Failed to open thumbnail picker:', error);
                    thumbnailPickerStatus.textContent = `Error: ${error.message}`;
                }
            }

            async function refreshMetadata() {
                if (!currentPath) {
                    return;
                }

                const normalizedPath = getMetadataPathForCurrentView();
                try {
                    status.textContent = 'Refreshing metadata...';
                    const response = await fetch('/api/metadata-refresh', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: normalizedPath })
                    });
                    if (!response.ok) {
                        throw new Error(`Server error: ${response.statusText}`);
                    }
                    await loadDirectory(currentPath);
                    status.textContent = '';
                } catch (error) {
                    console.error('Failed to refresh metadata:', error);
                    status.textContent = `Error: ${error.message}`;
                }
            }

            async function saveMetadataSelection(normalizedPath, selectedCandidate) {
                const response = await fetch('/api/metadata-selection', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        path: normalizedPath,
                        selectedCandidate
                    })
                });
                if (!response.ok) {
                    throw new Error(`Server error: ${response.statusText}`);
                }
            }

            async function openMetadataPicker() {
                if (!currentPath) {
                    return;
                }

                const normalizedPath = getMetadataPathForCurrentView();
                openPickerOverlay(metadataPicker);
                metadataPickerStatus.textContent = 'Loading metadata options...';
                metadataPickerGrid.innerHTML = '';

                try {
                    const response = await fetch(`/api/metadata-options?path=${encodeURIComponent(normalizedPath)}`);
                    if (!response.ok) {
                        throw new Error(`Server error: ${response.statusText}`);
                    }
                    const data = await response.json();
                    const currentTmdbId = Number(data.currentSelection?.tmdbId) || null;
                    metadataPickerStatus.textContent = data.currentSelection?.locked
                        ? 'This item is currently locked to a manual metadata choice.'
                        : 'Pick the TMDB entry that should represent this item.';

                    data.candidates.forEach((candidate) => {
                        const button = document.createElement('button');
                        button.type = 'button';
                        button.className = 'metadata-option';
                        button.style.setProperty('--picker-delay', `${Math.min(metadataPickerGrid.children.length, 7) * 35}ms`);
                        if (currentTmdbId && Number(candidate.tmdbId) === currentTmdbId) {
                            button.classList.add('active');
                        }

                        const yearLabel = candidate.year ? ` (${candidate.year})` : '';
                        const ratingLabel = candidate.rating ? `Rating ${candidate.rating.toFixed(1)}` : 'No rating';
                        button.innerHTML = `
                            ${candidate.posterUrl ? `<img src="${candidate.posterUrl}" alt="${candidate.matchedTitle || candidate.name}">` : '<div class="card-preview" style="aspect-ratio:2/3;display:flex;align-items:center;justify-content:center;">No poster</div>'}
                            <div class="thumbnail-option-body">
                                <div class="thumbnail-option-label">${candidate.matchedTitle || candidate.name}${yearLabel}</div>
                                <div class="thumbnail-option-source">${ratingLabel}</div>
                                <div class="metadata-option-summary">${candidate.description || 'No description available.'}</div>
                            </div>
                        `;
                        button.addEventListener('click', async () => {
                            try {
                                metadataPickerStatus.textContent = 'Saving metadata match...';
                                await saveMetadataSelection(normalizedPath, candidate);
                                closeMetadataPicker();
                                await loadDirectory(currentPath);
                            } catch (error) {
                                console.error('Failed to save metadata selection:', error);
                                metadataPickerStatus.textContent = `Error: ${error.message}`;
                            }
                        });
                        metadataPickerGrid.appendChild(button);
                    });
                } catch (error) {
                    console.error('Failed to open metadata picker:', error);
                    metadataPickerStatus.textContent = `Error: ${error.message}`;
                }
            }

            function updateFileCardProgress(card, progress, duration) {
                const existingProgressBar = card.querySelector('.progress-bar-container');
                if (existingProgressBar) {
                    existingProgressBar.remove();
                }
                const existingIcon = card.querySelector('.watched-icon');
                if (existingIcon) {
                    existingIcon.remove();
                }

                if (progress > 0 && duration > 0) {
                    const percentage = (progress / duration) * 100;
                    let overlayHTML = '';
                    if (percentage >= 95) {
                        overlayHTML = `<div class="watched-icon"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg></div>`;
                    } else {
                        overlayHTML = `<div class="progress-bar-container" style="position: absolute; bottom: 0; left: 0; right: 0; height: 4px; background-color: rgba(0,0,0,0.5);"><div class="progress-bar" style="height:100%; width: ${percentage}%; background-color: #DC2626;"></div></div>`;
                    }
                    card.querySelector('.card-preview').insertAdjacentHTML('beforeend', overlayHTML);
                }
            }

            contextMenu.addEventListener('click', (e) => {
                if (e.target.tagName !== 'BUTTON' || !currentContextMenuFile) {
                    contextMenu.style.display = 'none';
                    return;
                }

                const watched = e.target.dataset.action === 'mark-watched';
                const videoFile = currentContextMenuFile;

                // --- OPTIMISTIC UI UPDATE ---
                const cardsToUpdate = document.querySelectorAll(`[data-file-url="${videoFile}"]`);
                
                cardsToUpdate.forEach(card => {
                    const duration = parseFloat(card.dataset.duration) || 0;
                    const newTime = watched ? duration : 0;
                    
                    // Update progress/vinkje on all cards
                    updateFileCardProgress(card, newTime, duration);

                    // If marking as watched, also remove from "Continue Watching" list
                    if (watched && continueWatchingRow.contains(card)) {
                        card.remove();
                    }
                });

                // If we just removed the last card from Continue Watching, hide the whole row
                if (watched && continueWatchingRow.querySelector('.items-scroller')?.children.length === 0) {
                    continueWatchingRow.style.display = 'none';
                }
                // --- END OPTIMISTIC UI UPDATE ---

                // Send the update to the server
                socket.emit('markVideo', { videoFile, watched });
                
                contextMenu.style.display = 'none';
            });

            folderOptionsButton.addEventListener('click', (e) => {
                e.stopPropagation();
                const isVisible = folderOptionsMenu.style.display === 'block';
                folderOptionsMenu.style.display = isVisible ? 'none' : 'block';
            });

            folderOptionsMenu.addEventListener('click', (e) => {
                if (e.target.tagName === 'BUTTON' && currentPath) {
                    const action = e.target.dataset.action;
                    if (action === 'mark-all-watched' || action === 'mark-all-unwatched') {
                        const watched = action === 'mark-all-watched';
                        socket.emit('markFolder', { folderPath: currentPath, watched });
                    } else if (action === 'refresh-metadata') {
                        void refreshMetadata();
                    } else if (action === 'change-metadata') {
                        void openMetadataPicker();
                    } else if (action === 'change-thumbnail') {
                        void openThumbnailPicker();
                    }
                }
                folderOptionsMenu.style.display = 'none';
            });

            const handleSearchInput = () => {
                if (!searchShell) {
                    return;
                }
                const query = searchInput.value.trim();
                renderSearchAssist({ query });
                clearTimeout(searchTimer);
                searchTimer = setTimeout(() => {
                    currentSearchQuery = query;
                    if (query.length >= 2) {
                        const nextUrl = new URL(window.location.href);
                        nextUrl.searchParams.delete('path');
                        nextUrl.searchParams.set('q', query);
                        window.history.replaceState({}, document.title, `${nextUrl.pathname}?${nextUrl.searchParams.toString()}`);
                        loadSearchResults(query);
                        return;
                    }

                    const nextUrl = new URL(window.location.href);
                    nextUrl.searchParams.delete('q');
                    window.history.replaceState({}, document.title, nextUrl.search);
                    if (currentPath) {
                        loadDirectory(currentPath);
                    } else {
                        loadHomepage();
                    }
                    renderSearchAssist({ query: '' });
                }, 250);
            };

            if (searchInput && clearSearchButton && searchShell) {
                searchInput.addEventListener('input', handleSearchInput);
                searchInput.addEventListener('search', handleSearchInput);
                searchInput.addEventListener('change', handleSearchInput);
                searchInput.addEventListener('focus', () => {
                    renderSearchAssist({ query: searchInput.value.trim() });
                });
                searchInput.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter') {
                        const activeChip = searchAssist?.querySelector('.search-chip.is-active[data-search-query]');
                        if (activeChip) {
                            event.preventDefault();
                            activeChip.click();
                            return;
                        }
                        event.preventDefault();
                        handleSearchInput();
                        return;
                    }
                    if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        setActiveSearchAssistChip(activeSearchAssistIndex + 1);
                        return;
                    }
                    if (event.key === 'ArrowUp') {
                        event.preventDefault();
                        setActiveSearchAssistChip(activeSearchAssistIndex - 1);
                        return;
                    }
                    if (event.key === 'Escape') {
                        activeSearchAssistIndex = -1;
                        renderSearchAssist({ query: currentSearchQuery });
                    }
                });
                searchAssist?.addEventListener('click', (event) => {
                    const actionButton = event.target.closest('[data-search-action]');
                    if (actionButton?.dataset.searchAction === 'clear-history') {
                        clearRecentSearches();
                        renderSearchAssist({ query: searchInput.value.trim() });
                        return;
                    }
                    const button = event.target.closest('[data-search-query]');
                    if (!button) {
                        return;
                    }
                    const query = button.dataset.searchQuery || '';
                    searchInput.value = query;
                    currentSearchQuery = query;
                    handleSearchInput();
                });

                clearSearchButton.addEventListener('click', () => {
                    handleSearchInput();
                });
            }

            installAppButton?.addEventListener('click', async () => {
                if (!deferredInstallPrompt) {
                    return;
                }

                const promptEvent = deferredInstallPrompt;
                deferredInstallPrompt = null;
                updateInstallButton();

                try {
                    await promptEvent.prompt();
                    const choice = await promptEvent.userChoice;
                    if (choice?.outcome === 'accepted') {
                        status.textContent = 'Install prompt opened.';
                    }
                } catch (error) {
                    console.error('Install prompt failed:', error);
                }
            });

            window.addEventListener('beforeinstallprompt', (event) => {
                event.preventDefault();
                deferredInstallPrompt = event;
                updateInstallButton();
            });

            window.addEventListener('appinstalled', () => {
                deferredInstallPrompt = null;
                updateInstallButton();
                status.textContent = 'Tvstack installed.';
                window.setTimeout(() => {
                    if (status.textContent === 'Tvstack installed.') {
                        status.textContent = '';
                    }
                }, 2200);
            });

            installDisplayModeQuery?.addEventListener?.('change', updateInstallButton);
            updateInstallButton();

            window.addEventListener('click', () => {
                contextMenu.style.display = 'none';
                folderOptionsMenu.style.display = 'none';
            });

            closeThumbnailPickerButton.addEventListener('click', closeThumbnailPicker);
            thumbnailPicker.addEventListener('click', (event) => {
                if (event.target === thumbnailPicker) {
                    closeThumbnailPicker();
                }
            });
            closeMetadataPickerButton.addEventListener('click', closeMetadataPicker);
            metadataPicker.addEventListener('click', (event) => {
                if (event.target === metadataPicker) {
                    closeMetadataPicker();
                }
            });
            clearMetadataLockButton.addEventListener('click', async () => {
                if (!currentPath) {
                    return;
                }
                try {
                    metadataPickerStatus.textContent = 'Switching back to automatic matching...';
                    await saveMetadataSelection(getMetadataPathForCurrentView(), null);
                    closeMetadataPicker();
                    await loadDirectory(currentPath);
                } catch (error) {
                    console.error('Failed to clear metadata lock:', error);
                    metadataPickerStatus.textContent = `Error: ${error.message}`;
                }
            });
            socket.on('folderMarked', ({ folderPath, watched }) => {
                if (folderPath === currentPath) {
                    loadDirectory(currentPath); // Reload to see all changes
                }
            });

            socket.on('videoMarked', ({ videoFile, watched, time }) => {
                const isHomepage = folderViewContainer.style.display === 'none';

                // If on the homepage, refresh the continue watching list.
                if (isHomepage) {
                    loadRecentlyWatched();
                }

                // Update all instances of this card on the page (e.g., in a category row and in the folder grid).
                const cardsToUpdate = document.querySelectorAll(`[data-file-url="${videoFile}"]`);
                cardsToUpdate.forEach(card => {
                    const duration = parseFloat(card.dataset.duration);
                    updateFileCardProgress(card, time, duration);
                });
            });

            // --- Initial Load ---
            const queryParams = new URLSearchParams(window.location.search);
            const initialPath = queryParams.get('path');
            const initialQuery = queryParams.get('q');
            if (initialQuery && searchShell) {
                searchInput.value = initialQuery;
                currentSearchQuery = initialQuery;
                renderSearchAssist({ query: initialQuery });
                loadSearchResults(initialQuery);
                return;
            }
            if (initialPath) {
                renderSearchAssist({ query: '' });
                loadDirectory(initialPath);
            } else {
                renderSearchAssist({ query: '' });
                loadHomepage();
            }
        });
    
