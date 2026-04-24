import AccountTreeIcon from '@mui/icons-material/AccountTree';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import GroupsIcon from '@mui/icons-material/Groups';
import SearchIcon from '@mui/icons-material/Search';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  Pagination,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import type { CSSProperties } from 'react';
import { useEffect, useMemo, useState } from 'react';

import { fetchProjects, fetchSessionSection, fetchSessions } from '../lib/api';
import {
  type LoadedSessionDocumentSection,
  loadSessionDocument,
  resolveSessionDocumentPlan,
  sessionDisplayLabel,
} from '../lib/session-document';
import { downloadSessionExportHtmlClient } from '../lib/session-export';
import { useUrlParam } from '../lib/use-url-state';
import { SessionPane } from './SessionPane';

// ひらがな・カタカナを正規化（カタカナ→ひらがな変換）して同一視する
function normalizeKana(str: string): string {
  return str.replace(/[\u30A1-\u30F6]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60),
  );
}

function renderTimestamp(timestamp: string | null): string {
  if (!timestamp) {
    return '';
  }

  try {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHour = Math.floor(diffMs / 3600000);
    const diffDay = Math.floor(diffMs / 86400000);

    if (diffMin < 1) return 'たった今';
    if (diffMin < 60) return `${diffMin}分前`;
    if (diffHour < 24) return `${diffHour}時間前`;
    if (diffDay < 7) return `${diffDay}日前`;
    return date.toLocaleDateString('ja-JP', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return timestamp;
  }
}

function HighlightedText({
  text,
  query,
  sx,
}: {
  text: string;
  query: string;
  sx?: object;
}) {
  if (!query) {
    return <span style={sx as CSSProperties}>{text}</span>;
  }

  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) {
    return <span style={sx as CSSProperties}>{text}</span>;
  }

  return (
    <span style={sx as CSSProperties}>
      {text.slice(0, idx)}
      <mark
        style={{
          background: 'rgba(255, 200, 0, 0.35)',
          color: 'inherit',
          borderRadius: 2,
          padding: '0 1px',
        }}
      >
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </span>
  );
}

const SESSION_PAGE_SIZE = 20;

export function App() {
  const [selectedSectionTab, setSelectedSectionTab] = useState(0);
  const [selectedProjectId, setSelectedProjectId] = useUrlParam('project');
  const [selectedSessionId, setSelectedSessionId] = useUrlParam('session');
  const [projectSearch, setProjectSearch] = useUrlParam('pq');
  const [showProjectPane, setShowProjectPane] = useState(true);
  const [showEmptyProjects, setShowEmptyProjects] = useState(false);
  const [minReqStr, setMinReqStr] = useUrlParam('min_req');
  const minRequestThreshold = Math.max(0, parseInt(minReqStr || '5', 10) || 0);
  const [isExportingHtml, setIsExportingHtml] = useState(false);
  const [sessionSearch, setSessionSearch] = useState('');
  const [sessionPage, setSessionPage] = useState(0);

  const resolvedProjectId = selectedProjectId || null;

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
  });

  useEffect(() => {
    setSessionPage(0);
  }, [resolvedProjectId, sessionSearch]);

  const projects = projectsQuery.data ?? [];

  const visibleProjects = useMemo(() => {
    const base = showEmptyProjects
      ? projects
      : projects.filter((project) => project.session_count > 0);
    if (!projectSearch) return base;
    const q = normalizeKana(projectSearch.toLowerCase());
    return base
      .map((project) => {
        const nameMatch = normalizeKana(
          project.display_name.toLowerCase(),
        ).includes(q);
        const filteredWorktrees = project.worktrees.filter((wt) =>
          normalizeKana(wt.display_name.toLowerCase()).includes(q),
        );
        if (nameMatch || filteredWorktrees.length > 0) {
          return {
            ...project,
            worktrees: nameMatch ? project.worktrees : filteredWorktrees,
          };
        }
        return null;
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);
  }, [projects, showEmptyProjects, projectSearch]);

  const hiddenProjectCount = useMemo(
    () => projects.filter((project) => project.session_count === 0).length,
    [projects],
  );

  useEffect(() => {
    if (!resolvedProjectId && visibleProjects.length > 0) {
      setSelectedProjectId(visibleProjects[0].id);
    }
  }, [resolvedProjectId, visibleProjects]);

  const sessionsQuery = useQuery({
    queryKey: ['sessions', resolvedProjectId],
    queryFn: () => fetchSessions(resolvedProjectId ?? ''),
    enabled: resolvedProjectId !== null,
  });

  const sessions = sessionsQuery.data ?? [];

  const visibleSessions = useMemo(() => {
    let base = sessions as typeof sessions;
    if (minRequestThreshold > 0) {
      base = base.filter(
        (session) => session.request_count >= minRequestThreshold,
      );
    }
    if (!sessionSearch) return base;
    const q = normalizeKana(sessionSearch.toLowerCase());
    return base.filter((session) =>
      normalizeKana(session.first_message?.toLowerCase() ?? '').includes(q),
    );
  }, [sessions, minRequestThreshold, sessionSearch]);

  const paginatedSessions = useMemo(
    () =>
      visibleSessions.slice(
        sessionPage * SESSION_PAGE_SIZE,
        (sessionPage + 1) * SESSION_PAGE_SIZE,
      ),
    [visibleSessions, sessionPage],
  );

  useEffect(() => {
    if (!sessionsQuery.isSuccess) return;
    if (!sessions.length) {
      setSelectedSessionId(null);
      return;
    }
    if (
      !selectedSessionId ||
      !sessions.some((s) => s.session_id === selectedSessionId)
    ) {
      setSelectedSessionId(sessions[0].session_id);
    }
  }, [selectedSessionId, sessions, sessionsQuery.isSuccess]);

  const selectedSessionFile = useMemo(() => {
    if (!selectedSessionId || !sessions.length) return null;
    const found = sessions.find((s) => s.session_id === selectedSessionId);
    return found?.jsonl_path ?? null;
  }, [selectedSessionId, sessions]);

  const selectedProject = useMemo(() => {
    if (!resolvedProjectId) return null;
    const base = projects.find((project) => project.id === resolvedProjectId);
    if (base) return base;
    for (const project of projects) {
      const wt = project.worktrees.find((w) => w.id === resolvedProjectId);
      if (wt) return { ...wt, worktrees: [] as typeof project.worktrees };
    }
    return null;
  }, [projects, resolvedProjectId]);

  const selectedDocumentPlan = useMemo(
    () =>
      selectedSessionFile
        ? resolveSessionDocumentPlan(sessions, selectedSessionFile)
        : null,
    [selectedSessionFile, sessions],
  );

  useEffect(() => {
    setSelectedSectionTab(0);
  }, [selectedSessionFile]);

  const activeSectionPlan =
    selectedDocumentPlan?.sections[
      Math.min(
        Math.max(selectedSectionTab, 0),
        Math.max((selectedDocumentPlan?.sections.length ?? 1) - 1, 0),
      )
    ] ?? null;

  const activeSectionQuery = useQuery({
    queryKey: ['session-section', activeSectionPlan?.filePath ?? ''],
    queryFn: async (): Promise<LoadedSessionDocumentSection> => {
      const section = activeSectionPlan as NonNullable<
        typeof activeSectionPlan
      >;
      const { messages, analysis } = await fetchSessionSection(
        section.filePath,
      );

      return {
        ...section,
        messages,
        analysis,
      };
    },
    enabled: activeSectionPlan !== null,
  });

  async function handleExportHtml(): Promise<void> {
    if (!selectedDocumentPlan || isExportingHtml) {
      return;
    }

    try {
      setIsExportingHtml(true);
      const document = await loadSessionDocument(selectedDocumentPlan);
      await downloadSessionExportHtmlClient({
        document,
        selectedSectionIndex: selectedSectionTab,
      });
    } catch (error) {
      window.alert(
        error instanceof Error ? error.message : 'HTML export に失敗しました。',
      );
    } finally {
      setIsExportingHtml(false);
    }
  }

  return (
    <Box
      sx={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.default',
        color: 'text.primary',
        overflow: 'hidden',
      }}
    >
      <Stack direction="row" spacing={0} sx={{ flex: 1, overflow: 'hidden' }}>
        <Box
          sx={{
            width: showProjectPane ? 240 : 44,
            flexShrink: 0,
            borderRight: 1,
            borderColor: 'divider',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            bgcolor: 'rgba(0,0,0,0.25)',
            transition: 'width 160ms ease',
          }}
        >
          {showProjectPane ? (
            <>
              <Box
                sx={{
                  px: 2,
                  py: 1.25,
                  borderBottom: 1,
                  borderColor: 'divider',
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                  <IconButton
                    size="small"
                    onClick={() => setShowProjectPane(false)}
                    title="プロジェクト列を隠す"
                    aria-label="プロジェクト列を隠す"
                    sx={{ color: 'text.secondary' }}
                  >
                    <ChevronLeftIcon sx={{ fontSize: 20 }} />
                  </IconButton>
                  <Typography
                    variant="caption"
                    sx={{
                      fontWeight: 600,
                      color: 'text.secondary',
                      letterSpacing: 0.3,
                    }}
                  >
                    プロジェクト
                  </Typography>
                </Box>
                {hiddenProjectCount > 0 && (
                  <Button
                    size="small"
                    onClick={() => setShowEmptyProjects((value) => !value)}
                    sx={{
                      fontSize: 11,
                      py: 0,
                      minWidth: 0,
                      color: 'primary.main',
                    }}
                  >
                    {showEmptyProjects ? '空を非表示' : '空を表示'}
                  </Button>
                )}
              </Box>
              <Box
                sx={{
                  px: 1.5,
                  py: 0.75,
                  borderBottom: 1,
                  borderColor: 'divider',
                  flexShrink: 0,
                }}
              >
                <TextField
                  size="small"
                  placeholder="プロジェクトを検索..."
                  value={projectSearch}
                  onChange={(e) => setProjectSearch(e.target.value)}
                  fullWidth
                  slotProps={{
                    input: {
                      startAdornment: (
                        <InputAdornment position="start">
                          <SearchIcon
                            sx={{ fontSize: 14, color: 'text.disabled' }}
                          />
                        </InputAdornment>
                      ),
                      sx: { fontSize: 12 },
                    },
                  }}
                  sx={{ '& .MuiInputBase-root': { height: 28 } }}
                />
              </Box>
              <Box sx={{ flex: 1, overflowY: 'auto' }}>
                {projectsQuery.isLoading ? (
                  <Box sx={{ p: 3, display: 'flex', justifyContent: 'center' }}>
                    <CircularProgress size={20} />
                  </Box>
                ) : projectsQuery.error ? (
                  <Alert severity="error" sx={{ m: 1, fontSize: 12 }}>
                    {(projectsQuery.error as Error).message}
                  </Alert>
                ) : (
                  <>
                    <List dense disablePadding>
                      {visibleProjects.map((project) => {
                        const isSelected = project.id === selectedProjectId;
                        return (
                          <Box key={project.id}>
                            <ListItemButton
                              selected={isSelected}
                              onClick={() => setSelectedProjectId(project.id)}
                              sx={{
                                py: 1,
                                px: 2,
                                borderLeft: 3,
                                borderColor: isSelected
                                  ? 'primary.main'
                                  : 'transparent',
                              }}
                            >
                              <Box>
                                <Typography
                                  sx={{
                                    fontSize: 13,
                                    fontWeight: isSelected ? 700 : 400,
                                    lineHeight: 1.3,
                                  }}
                                >
                                  <HighlightedText
                                    text={project.display_name}
                                    query={projectSearch}
                                  />
                                </Typography>
                                <Typography
                                  variant="caption"
                                  sx={{ color: 'text.secondary', fontSize: 11 }}
                                >
                                  {project.session_count} sessions
                                </Typography>
                              </Box>
                            </ListItemButton>
                            {project.worktrees.map((wt) => {
                              const isWtSelected = wt.id === selectedProjectId;
                              return (
                                <ListItemButton
                                  key={wt.id}
                                  selected={isWtSelected}
                                  onClick={() => setSelectedProjectId(wt.id)}
                                  sx={{
                                    py: 0.75,
                                    pl: 3.5,
                                    pr: 2,
                                    borderLeft: 3,
                                    borderColor: isWtSelected
                                      ? 'primary.main'
                                      : 'transparent',
                                  }}
                                >
                                  <Box
                                    sx={{
                                      display: 'flex',
                                      alignItems: 'flex-start',
                                      gap: 0.5,
                                    }}
                                  >
                                    <AccountTreeIcon
                                      sx={{
                                        fontSize: 12,
                                        color: 'text.disabled',
                                        mt: '3px',
                                        flexShrink: 0,
                                      }}
                                    />
                                    <Box>
                                      <Typography
                                        sx={{
                                          fontSize: 12,
                                          fontWeight: isWtSelected ? 700 : 400,
                                          lineHeight: 1.3,
                                          color: isWtSelected
                                            ? 'text.primary'
                                            : 'text.secondary',
                                        }}
                                      >
                                        <HighlightedText
                                          text={wt.display_name}
                                          query={projectSearch}
                                        />
                                      </Typography>
                                      <Typography
                                        variant="caption"
                                        sx={{
                                          color: 'text.disabled',
                                          fontSize: 10,
                                        }}
                                      >
                                        {wt.session_count} sessions
                                      </Typography>
                                    </Box>
                                  </Box>
                                </ListItemButton>
                              );
                            })}
                          </Box>
                        );
                      })}
                    </List>
                    {!showEmptyProjects && hiddenProjectCount > 0 && (
                      <Box sx={{ px: 2, py: 1 }}>
                        <Typography
                          variant="caption"
                          sx={{
                            color: 'text.disabled',
                            fontSize: 11,
                            cursor: 'pointer',
                          }}
                          onClick={() => setShowEmptyProjects(true)}
                        >
                          {hiddenProjectCount}{' '}
                          件のセッションなしのプロジェクトを非表示
                        </Typography>
                      </Box>
                    )}
                  </>
                )}
              </Box>
            </>
          ) : (
            <Box
              sx={{
                pt: 0.75,
                display: 'flex',
                justifyContent: 'flex-start',
                px: 0.75,
                flexShrink: 0,
              }}
            >
              <IconButton
                size="small"
                onClick={() => setShowProjectPane(true)}
                title="プロジェクト列を表示"
                aria-label="プロジェクト列を表示"
                sx={{ color: 'text.secondary' }}
              >
                <ChevronRightIcon sx={{ fontSize: 20 }} />
              </IconButton>
            </Box>
          )}
        </Box>

        <Box
          sx={{
            width: 300,
            flexShrink: 0,
            borderRight: 1,
            borderColor: 'divider',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            bgcolor: 'background.paper',
          }}
        >
          <Box
            sx={{
              px: 2,
              py: 1.25,
              borderBottom: 1,
              borderColor: 'divider',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              minHeight: 40,
            }}
          >
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                minWidth: 0,
                flex: 1,
              }}
            >
              <Typography
                sx={{
                  fontSize: 13,
                  fontWeight: 600,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {selectedProject
                  ? `${selectedProject.display_name} (${selectedProject.session_count})`
                  : 'Sessions'}
              </Typography>
            </Box>
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.25,
                border: 1,
                borderColor: 'divider',
                borderRadius: 1,
                overflow: 'hidden',
              }}
            >
              <Button
                size="small"
                onClick={() =>
                  setMinReqStr(String(Math.max(0, minRequestThreshold - 1)))
                }
                disabled={minRequestThreshold <= 0}
                sx={{
                  minWidth: 22,
                  px: 0,
                  py: 0,
                  height: 22,
                  fontSize: 14,
                  lineHeight: 1,
                  borderRadius: 0,
                }}
              >
                −
              </Button>
              <Typography
                sx={{
                  fontSize: 11,
                  color: 'text.secondary',
                  minWidth: 28,
                  textAlign: 'center',
                  userSelect: 'none',
                }}
              >
                {minRequestThreshold}
              </Typography>
              <Button
                size="small"
                onClick={() => setMinReqStr(String(minRequestThreshold + 1))}
                sx={{
                  minWidth: 22,
                  px: 0,
                  py: 0,
                  height: 22,
                  fontSize: 14,
                  lineHeight: 1,
                  borderRadius: 0,
                }}
              >
                +
              </Button>
            </Box>
          </Box>
          <Box
            sx={{
              px: 1.5,
              py: 0.75,
              borderBottom: 1,
              borderColor: 'divider',
              flexShrink: 0,
            }}
          >
            <TextField
              size="small"
              placeholder="セッションを検索..."
              value={sessionSearch}
              onChange={(e) => setSessionSearch(e.target.value)}
              fullWidth
              slotProps={{
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon
                        sx={{ fontSize: 14, color: 'text.disabled' }}
                      />
                    </InputAdornment>
                  ),
                  sx: { fontSize: 12 },
                },
              }}
              sx={{ '& .MuiInputBase-root': { height: 28 } }}
            />
          </Box>
          <Box sx={{ flex: 1, overflowY: 'auto' }}>
            {sessionsQuery.isLoading ? (
              <Box sx={{ p: 3, display: 'flex', justifyContent: 'center' }}>
                <CircularProgress size={20} />
              </Box>
            ) : sessionsQuery.error ? (
              <Alert severity="error" sx={{ m: 1, fontSize: 12 }}>
                {(sessionsQuery.error as Error).message}
              </Alert>
            ) : (
              <List dense disablePadding>
                {paginatedSessions.map((session) => {
                  const nestedSubagentCount = session.team_sessions.reduce(
                    (sum, teamSession) => sum + teamSession.subagents.length,
                    0,
                  );
                  const totalSubagentCount =
                    session.subagents.length + nestedSubagentCount;

                  return (
                    <ListItemButton
                      key={session.session_id}
                      selected={session.session_id === selectedSessionId}
                      onClick={() => setSelectedSessionId(session.session_id)}
                      sx={{
                        py: 1,
                        px: 2,
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        borderBottom: 1,
                        borderColor: 'divider',
                      }}
                    >
                      <Typography
                        sx={{
                          fontSize: 13,
                          fontWeight:
                            session.jsonl_path === selectedSessionFile
                              ? 600
                              : 400,
                          width: '100%',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          lineHeight: 1.4,
                        }}
                      >
                        <HighlightedText
                          text={sessionDisplayLabel(session)}
                          query={sessionSearch}
                        />
                      </Typography>
                      <Box
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 0.75,
                          mt: 0.25,
                        }}
                      >
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ fontSize: 11 }}
                        >
                          {renderTimestamp(session.timestamp)}
                        </Typography>
                        {totalSubagentCount > 0 && (
                          <Chip
                            icon={
                              <SmartToyIcon
                                sx={{ fontSize: '11px !important' }}
                              />
                            }
                            label={totalSubagentCount}
                            size="small"
                            sx={{
                              height: 16,
                              fontSize: 10,
                              '& .MuiChip-label': { px: 0.5 },
                              '& .MuiChip-icon': { ml: 0.5 },
                            }}
                          />
                        )}
                        {session.team_sessions.length > 0 && (
                          <Chip
                            icon={
                              <GroupsIcon
                                sx={{ fontSize: '11px !important' }}
                              />
                            }
                            label={session.team_sessions.length}
                            size="small"
                            sx={{
                              height: 16,
                              fontSize: 10,
                              '& .MuiChip-label': { px: 0.5 },
                              '& .MuiChip-icon': { ml: 0.5 },
                            }}
                          />
                        )}
                      </Box>
                    </ListItemButton>
                  );
                })}
              </List>
            )}
          </Box>
          {visibleSessions.length > SESSION_PAGE_SIZE && (
            <Box
              sx={{
                px: 1,
                py: 0.75,
                borderTop: 1,
                borderColor: 'divider',
                flexShrink: 0,
                display: 'flex',
                justifyContent: 'center',
              }}
            >
              <Pagination
                count={Math.ceil(visibleSessions.length / SESSION_PAGE_SIZE)}
                page={sessionPage + 1}
                onChange={(_, page) => setSessionPage(page - 1)}
                size="small"
                siblingCount={0}
              />
            </Box>
          )}
        </Box>

        <Box
          sx={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {!selectedSessionFile ? (
            <Box sx={{ p: 3 }}>
              <Typography color="text.secondary">
                セッションを選択してください。
              </Typography>
            </Box>
          ) : !selectedDocumentPlan ? (
            <Box sx={{ p: 3 }}>
              <Typography color="text.secondary">
                document を読み込めませんでした。
              </Typography>
            </Box>
          ) : (
            <SessionPane
              document={selectedDocumentPlan}
              mode="interactive"
              activeSection={activeSectionQuery.data ?? null}
              isSectionLoading={activeSectionQuery.isLoading}
              sectionError={(activeSectionQuery.error as Error | null) ?? null}
              selectedSectionIndex={selectedSectionTab}
              onSectionSelect={setSelectedSectionTab}
              onExportHtml={() => {
                void handleExportHtml();
              }}
              isExportingHtml={isExportingHtml}
            />
          )}
        </Box>
      </Stack>
    </Box>
  );
}
