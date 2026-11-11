# Graph Report - Automation  (2026-10-28)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 3210 nodes · 9630 edges · 118 communities (107 shown, 11 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 177 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `1540b2c8`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6
- Community 7
- Community 8
- Community 10
- Community 11
- Community 12
- Community 13
- Community 14
- Community 15
- Community 16
- Community 17
- Community 18
- Community 19
- Community 20
- Community 21
- Community 22
- Community 23
- Community 24
- Community 25
- Community 26
- Community 27
- Community 28
- Community 29
- Community 30
- Community 31
- Community 32
- Community 33
- Community 34
- Community 35
- Community 36
- Community 37
- Community 38
- Community 39
- Community 40
- Community 41
- Community 42
- Community 43
- Community 44
- Community 45
- Community 46
- Community 47
- Community 48
- Community 49
- Community 50
- Community 51
- Community 52
- Community 53
- Community 54
- Community 55
- Community 56
- Community 57
- Community 58
- Community 59
- Community 61
- Community 62
- Community 63
- Community 64
- Community 65
- Community 66
- Community 67
- Community 68
- Community 69
- Community 70
- Community 71
- Community 72
- Community 73
- Community 74
- Community 75
- Community 76
- Community 77
- Community 78
- Community 79
- Community 80
- Community 81
- Community 82
- Community 83
- Community 84
- Community 85
- Community 86
- Community 87
- Community 88
- Community 89
- Community 90
- Community 91
- Community 92
- Community 93
- Community 94
- Community 95
- Community 96
- Community 97
- Community 98
- Community 99
- Community 100
- Community 101
- Community 102
- Community 103
- Community 104
- Community 105
- Community 106
- Community 107
- Community 108
- Community 109
- Community 110
- Community 112
- Community 113
- Community 114

## God Nodes (most connected - your core abstractions)
1. `run()` - 244 edges
2. `Html` - 141 edges
3. `get()` - 140 edges
4. `all()` - 127 edges
5. `raw()` - 102 edges
6. `errorMessage()` - 88 edges
7. `registerNewWebsiteRoutes()` - 86 edges
8. `FlowClient` - 69 edges
9. `vitest` - 61 edges
10. `registerKeywordRoutes()` - 60 edges

## Surprising Connections (you probably didn't know these)
- `collectDiagnostics()` --indirect_call--> `state()`  [INFERRED]
  services/imagegen/extension/background.js → src/newsite/platform-view.ts
- `connectToAgent()` --indirect_call--> `state()`  [INFERRED]
  services/imagegen/extension/background.js → src/newsite/platform-view.ts
- `client()` --calls--> `ImageClient`  [EXTRACTED]
  test/image-client.test.ts → src/integrations/images.ts
- `client()` --calls--> `FacebookClient`  [EXTRACTED]
  test/fb-publish.test.ts → src/integrations/facebook.ts
- `addSite()` --calls--> `run()`  [EXTRACTED]
  test/newsite-photo-jobs.test.ts → src/db/index.ts

## Import Cycles
- None detected.

## Communities (118 total, 11 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.04
Nodes (90): run(), transaction(), activateSite(), ARTICLE_IMAGES_PER_RUN, beginStep(), BlockedPair, blockLink(), BUFFER_ACCOUNT_LIMIT (+82 more)

### Community 1 - "Community 1"
Cohesion: 0.05
Nodes (26): _expires_at(), get_job(), JobResponse, assert_secure_config(), InsecureConfiguration, require_api_key(), close_db(), active() (+18 more)

### Community 2 - "Community 2"
Cohesion: 0.05
Nodes (76): deletePromptOverride(), getPromptOverride(), getPromptVersion(), listModelOverrides(), listPromptOverrides(), listPromptVersions(), PromptVersionRow, setPromptOverride() (+68 more)

### Community 3 - "Community 3"
Cohesion: 0.06
Nodes (52): claim_pending(), complete(), count_by_status(), create(), create_video(), fail(), get(), next_project_id() (+44 more)

### Community 4 - "Community 4"
Cohesion: 0.07
Nodes (66): SitePost, skippedKeywords(), CheckDeps, checkImport(), cleanDomain(), Column, existingKeywords(), FinderDeps (+58 more)

### Community 5 - "Community 5"
Cohesion: 0.06
Nodes (48): fastify, @fastify/formbody, backupBeforeMigrating(), closeDatabase(), log, openDatabase(), Param, pruneBackups() (+40 more)

### Community 6 - "Community 6"
Cohesion: 0.07
Nodes (64): BufferChannel, errorMessage(), bufferTokenOf(), ChannelRow, fbTokenOf(), getChannel(), secret(), addFirstComments() (+56 more)

### Community 7 - "Community 7"
Cohesion: 0.08
Nodes (52): describeProjectId(), GenerateChoice, log, startGenerateNow(), imagesPage(), PictureRouteDeps, queuedMessage(), registerPictureRoutes() (+44 more)

### Community 8 - "Community 8"
Cohesion: 0.04
Nodes (7): FlowClient, _is_ws_error(), random_headers(), test_a_missing_start_image_is_refused_before_the_network(), test_platform_hint_agrees_with_the_user_agent(), test_the_client_passes_the_project_through_to_the_extension(), test_no_references_is_refused_before_it_reaches_google()

### Community 10 - "Community 10"
Cohesion: 0.06
Nodes (37): image_model_catalogue(), _by_key(), catalogue(), discovery_done(), discovery_report(), ensure_discovered(), forget_all(), is_bad_name() (+29 more)

### Community 11 - "Community 11"
Cohesion: 0.06
Nodes (30): build_envelope(), _client_uuid(), _context(), find_media_id(), first_payload(), FlowBatchError, GeneratedImage, image_request() (+22 more)

### Community 12 - "Community 12"
Cohesion: 0.07
Nodes (51): publicBaseUrlProblem(), askPrompt(), languageRule(), automationLog(), generateBox(), afterArticlePublished(), syncCategoryIntros(), rememberSiteCategories() (+43 more)

### Community 13 - "Community 13"
Cohesion: 0.07
Nodes (23): _check_circuit_breaker(), _check_session_wall(), _moved_on_since(), _recent_failures(), run(), WorkerController, failures(), recent() (+15 more)

### Community 14 - "Community 14"
Cohesion: 0.05
Nodes (37): extract_media_id(), extract_output_url(), _FakeFlowClient, ok_response(), run_one(), test_a_2xx_status_is_not_an_error(), test_a_bad_request_is_not_retried(), test_a_disconnected_browser_is_retried() (+29 more)

### Community 15 - "Community 15"
Cohesion: 0.09
Nodes (46): getList(), listAuthors(), listCategories(), listPosts(), patchPost(), readPost(), saveCategoryIntro(), savePost() (+38 more)

### Community 16 - "Community 16"
Cohesion: 0.05
Nodes (22): chrome_start(), chrome_stop(), clear_hold(), extension_diagnostics(), extension_status(), get_credits(), _open_sign_in(), process_table() (+14 more)

### Community 17 - "Community 17"
Cohesion: 0.07
Nodes (23): extract_media_handle(), extract_media_url(), extract_operation(), extract_video_media_id(), extract_video_url(), rejected_the_request(), video_failed(), _video_metadata() (+15 more)

### Community 18 - "Community 18"
Cohesion: 0.10
Nodes (43): ImportCheck, addKeywordsStep(), addWizard(), articleStepPage(), busyRows(), CHEV, CSS, fieldLabel() (+35 more)

### Community 19 - "Community 19"
Cohesion: 0.09
Nodes (33): AppConfig, generatePassword(), loadConfig(), persistSecret(), readOrCreateSecret(), resolveAuthPassword(), resolveDataDir(), resolveEncryptionKey() (+25 more)

### Community 20 - "Community 20"
Cohesion: 0.09
Nodes (34): activeKeyword(), advance(), AUTOMATION_KEY, AUTOMATION_ON_AT, AutopilotState, autopilotTick(), checking, clock() (+26 more)

### Community 21 - "Community 21"
Cohesion: 0.09
Nodes (28): access_denied(), _dedupe(), forget(), _from_tables(), i2v_candidates(), _load(), out_of_credits(), plan() (+20 more)

### Community 22 - "Community 22"
Cohesion: 0.09
Nodes (10): set_operation(), ext_callback(), get_flow_client(), error_text(), is_error(), client(), test_a_callback_for_an_unknown_id_is_refused(), test_a_callback_resolves_the_waiting_request() (+2 more)

### Community 23 - "Community 23"
Cohesion: 0.07
Nodes (35): articleColorStyle(), COLOR_RULE, ColorStyle, NICHE_COLOR_STYLES, NicheGroup, styleLine(), withColorStyle(), ALT_WORDS (+27 more)

### Community 24 - "Community 24"
Cohesion: 0.12
Nodes (39): channelColor(), channelPageLink(), postLinkOf(), labelOf(), missingChannels(), postLinks(), sharePostRow(), sharingBusy() (+31 more)

### Community 25 - "Community 25"
Cohesion: 0.12
Nodes (37): channelTakes(), websiteChannels(), listPlanSocialPictures(), refreshPostLinksSoon(), createReelShares(), getReelShare(), listPlanReelShares(), reelDestinations() (+29 more)

### Community 26 - "Community 26"
Cohesion: 0.07
Nodes (36): get(), consecutiveFailuresForPair(), countHeldRuns(), countKeywords(), countRuns(), deleteFbToken(), dueRetry(), fbPageToken() (+28 more)

### Community 27 - "Community 27"
Cohesion: 0.10
Nodes (14): FacebookClient, FacebookClientOptions, FacebookError, facebookIdOf(), GraphError, log, PublishedReel, sameAddress() (+6 more)

### Community 28 - "Community 28"
Cohesion: 0.07
Nodes (14): captcha_image_path(), hold_file_of_its_own(), no_random_cooldown(), test_a_page_that_does_not_answer_leaves_the_three_known_names(), test_a_pin_job_asks_flow_for_a_3_4_picture(), test_the_page_is_asked_once_not_once_per_job(), FakeClient, fresh_db() (+6 more)

### Community 29 - "Community 29"
Cohesion: 0.12
Nodes (21): Fake, image(), run(), test_a_composer_that_refuses_the_prompt_fails_at_once(), test_a_listing_that_cannot_be_read_is_not_a_generation_failure(), test_a_listing_that_fails_before_the_click_stops_there(), test_a_message_already_on_the_page_is_not_this_jobs_error(), test_a_new_tile_with_an_id_gets_its_signed_link() (+13 more)

### Community 30 - "Community 30"
Cohesion: 0.07
Nodes (34): dependencies, fastify@^5.2.0, @fastify/formbody@^8.0.1, @fastify/multipart@^9.0.1, @fastify/static@^8.0.3, description, devDependencies, tailwindcss@^3.4.19 (+26 more)

### Community 31 - "Community 31"
Cohesion: 0.07
Nodes (31): accounts, answeredImages, ASPECT_LABELS, attached, _buildBatchLogPayload(), _buildFrontendEventsPayload(), _captchaTurn, composerTab() (+23 more)

### Community 32 - "Community 32"
Cohesion: 0.11
Nodes (27): asCount(), callOllama(), chat(), ChatMessage, ChatRequest, ChatResult, Completion, log (+19 more)

### Community 33 - "Community 33"
Cohesion: 0.12
Nodes (17): ensureWidget(), executeWithAssignNeuter(), executeWithPristine(), executeWithRetry(), mintCaptcha(), mintTail, resolveSitekey(), waitForGrecaptcha() (+9 more)

### Community 34 - "Community 34"
Cohesion: 0.10
Nodes (31): API_PLATFORMS, BufferChannelInput, ChannelContent, channelsFor(), channelWebsiteIds(), cleanCategories(), FacebookApiChannelInput, InstagramApiChannelInput (+23 more)

### Community 35 - "Community 35"
Cohesion: 0.10
Nodes (30): ACTION_NAMES, ArticleType, Context, LIMITS, log, makeSkeleton(), num(), parseSkeleton() (+22 more)

### Community 36 - "Community 36"
Cohesion: 0.08
Nodes (30): interval, retries, start_period, test, timeout, build, environment, healthcheck (+22 more)

### Community 37 - "Community 37"
Cohesion: 0.06
Nodes (30): API_HOST, API_KEY, API_PORT, CHROME_PROFILE_DIR, DB_PATH, FLOW_AGENT_DIR, FLOW_PROJECT_ID, IMAGE_BASE_URL (+22 more)

### Community 38 - "Community 38"
Cohesion: 0.11
Nodes (23): vitest, flowProjectProblem(), placeholderProjectId(), ProjectIdSource, ResolvedProjectId, resolveProjectId(), parseColorStyles(), CleanWebsite (+15 more)

### Community 39 - "Community 39"
Cohesion: 0.13
Nodes (29): apiName(), ADD_STEPS, addPlatformStep(), addViaStep(), addWizard(), BUFFER_FREE_WARNING, cancel, channelCard() (+21 more)

### Community 40 - "Community 40"
Cohesion: 0.15
Nodes (21): image_reply(), test_a_transport_error_is_passed_through_as_one(), test_an_answer_with_no_image_in_it_is_an_error_not_a_blank_success(), test_an_image_goes_out_as_a_batch_rpc_not_a_rest_call(), test_the_answer_is_in_the_shape_the_worker_already_reads(), test_the_image_submit_asks_for_the_image_captcha(), test_the_image_submit_names_its_project_so_the_tab_can_land_on_it(), test_the_rest_path_is_still_there_behind_the_flag() (+13 more)

### Community 41 - "Community 41"
Cohesion: 0.10
Nodes (25): ChannelRouteDeps, NewFlash, AI_MODELS, AUTOMATION_KEYS, checkImageService(), Fetch, idList(), KeySummary (+17 more)

### Community 42 - "Community 42"
Cohesion: 0.16
Nodes (25): GoogleAccount, ABOUT, imageModelCards(), ImageModelCatalogue, verdict(), WIRE, IMAGE_MODELS, accountButton() (+17 more)

### Community 43 - "Community 43"
Cohesion: 0.12
Nodes (27): buffer_accounts, decisions, events, idx_buffer_accounts_site, idx_decisions_created, idx_decisions_cycle, idx_events_created, idx_keywords_status (+19 more)

### Community 44 - "Community 44"
Cohesion: 0.15
Nodes (27): duplicateOf(), normalizeTitle(), Taken, PageKind, approveResearch(), callKey(), cleanFound(), cleanPlan() (+19 more)

### Community 45 - "Community 45"
Cohesion: 0.13
Nodes (26): ALT_MAX, ALT_MIN, checkAlt(), CheckContext, checkDescription(), checkFocusKeyword(), checkSlug(), checkTitle() (+18 more)

### Community 46 - "Community 46"
Cohesion: 0.09
Nodes (14): _add_missing_columns(), init_db(), _widen_orientation(), fresh_db(), old_database(), test_an_old_row_reads_as_empty_rather_than_null(), test_new_jobs_carry_their_project(), test_opening_twice_is_safe() (+6 more)

### Community 47 - "Community 47"
Cohesion: 0.11
Nodes (23): REEL_PLATFORMS, flowProjectFor(), ALL_PLATFORMS, articleParts(), checkReelScript(), defaultReelRules(), DOMAIN_PLACEHOLDER, FAILED (+15 more)

### Community 48 - "Community 48"
Cohesion: 0.09
Nodes (14): generate(), generate_video(), GenerateRequest, GenerateResponse, GenerateVideoRequest, _reject_if_unavailable(), stop_images(), wanted_running() (+6 more)

### Community 49 - "Community 49"
Cohesion: 0.17
Nodes (16): WatchdogState, check(), connected(), FakeController, fresh_state(), test_a_connected_extension_is_healthy(), test_a_deliberately_stopped_chrome_is_not_a_fault(), test_a_dropped_connection_restarts_after_the_short_grace() (+8 more)

### Community 50 - "Community 50"
Cohesion: 0.08
Nodes (26): all(), activeReels(), dailyActivity(), getLinksForKeyword(), keywordGroups(), keywordsInGroup(), listBlockedPairs(), listDecisions() (+18 more)

### Community 51 - "Community 51"
Cohesion: 0.17
Nodes (22): AuthOptions, hasValidSession(), issueToken(), loginPage(), passwordAccepted(), PUBLIC_PATHS, readCookie(), registerAuth() (+14 more)

### Community 52 - "Community 52"
Cohesion: 0.11
Nodes (8): test_sign_in_starts_chrome_and_asks_the_extension_to_open_google_sign_in(), client(), FakeFlowClient, test_chrome_is_started_and_pinned_for_it(), test_no_extension_is_an_answer_rather_than_a_hang(), test_the_project_asked_for_is_the_one_scanned(), test_the_scan_reports_the_controls_it_found(), wire()

### Community 53 - "Community 53"
Cohesion: 0.12
Nodes (18): ALT_WORDS, BANNED, checkSeo(), clean(), count(), EEAT, hasAllWords(), kickSeoWriter() (+10 more)

### Community 54 - "Community 54"
Cohesion: 0.12
Nodes (13): crx(), landing(), update_manifest(), _load(), remember(), resolve(), split(), url_for() (+5 more)

### Community 55 - "Community 55"
Cohesion: 0.18
Nodes (22): getDb(), call(), ensureTables(), finishJob(), JobRow, log, makeJob(), missingOn() (+14 more)

### Community 56 - "Community 56"
Cohesion: 0.15
Nodes (22): CATCH_UP_DAYS, colorStylesOf(), added(), catsSummary(), channelCategories(), channelLinks(), flowProject(), gap() (+14 more)

### Community 57 - "Community 57"
Cohesion: 0.17
Nodes (21): asIntent(), asPage(), closeness(), coreText(), coreWords(), Dropped, Existing, FILLER (+13 more)

### Community 58 - "Community 58"
Cohesion: 0.16
Nodes (19): ArticleDeps, BANNED_PHRASES, bodyWords(), checkSection(), cleanMarkdown(), Context, INGREDIENTS, isSoftProblem() (+11 more)

### Community 59 - "Community 59"
Cohesion: 0.17
Nodes (15): capture(), test_aspect_ratio_passes_through(), test_batch_id_is_a_fresh_uuid_each_call(), test_body_is_the_batch_wrapper(), test_captcha_action_is_requested(), test_client_context_matches_the_ui_shape(), test_context_is_repeated_inside_each_request_item(), test_headers_carry_the_full_browser_set() (+7 more)

### Community 61 - "Community 61"
Cohesion: 0.14
Nodes (20): AccountStatus, accountTrouble(), addGoogleAccount(), changeGoogleAccount(), checkAccountFields(), getGoogleAccount(), GOOGLE_ACCOUNT_BLOCKED_COOLDOWN_MS, GOOGLE_ACCOUNT_COOLDOWN_MS (+12 more)

### Community 62 - "Community 62"
Cohesion: 0.14
Nodes (17): checkRecipe(), Context, DIETS, log, makeRecipe(), parseRecipe(), RecipeDeps, recipeText() (+9 more)

### Community 63 - "Community 63"
Cohesion: 0.10
Nodes (19): compilerOptions, declaration, esModuleInterop, exactOptionalPropertyTypes, forceConsistentCasingInFileNames, lib, module, moduleResolution (+11 more)

### Community 64 - "Community 64"
Cohesion: 0.16
Nodes (11): build(), packed(), test_a_missing_pack_reports_503_rather_than_500(), test_chrome_lands_on_home_when_nothing_is_queued(), test_chrome_lands_on_the_queued_jobs_project(), next_project(), test_the_crx_is_served_with_chrome_content_type(), test_the_manifest_names_the_crx_route_this_service_serves() (+3 more)

### Community 65 - "Community 65"
Cohesion: 0.16
Nodes (17): Article, categoryArticles(), cleanIntro(), INTRO_MIN_ARTICLES, INTRO_REWRITE_DAYS, IntroDeps, introDue(), introProblems() (+9 more)

### Community 66 - "Community 66"
Cohesion: 0.29
Nodes (19): articleCard(), card(), fits(), imagesCard(), keptList(), pictureBox(), problemList(), publishCard() (+11 more)

### Community 67 - "Community 67"
Cohesion: 0.22
Nodes (18): createResearch(), deleteResearch(), isRunning(), listResearch(), form(), idOf(), log, one() (+10 more)

### Community 68 - "Community 68"
Cohesion: 0.17
Nodes (17): back(), ensureTables(), findTopics(), log, parseJson(), Post, readPosts(), registerTopListRoutes() (+9 more)

### Community 69 - "Community 69"
Cohesion: 0.15
Nodes (11): layout(), LayoutOptions, NavPage, NavSection, pageFor(), runBadge(), sectionFor(), SECTIONS (+3 more)

### Community 70 - "Community 70"
Cohesion: 0.16
Nodes (6): BufferBoard, BufferClient, BufferError, GraphQLResponse, realBuffer(), realBuffer()

### Community 71 - "Community 71"
Cohesion: 0.17
Nodes (11): Db, addColumn(), appliedMigrations(), columns(), ensureLedger(), hasTable(), log, Migration (+3 more)

### Community 72 - "Community 72"
Cohesion: 0.20
Nodes (17): addRequestLog(), broadcastRequestLog(), broadcastStatus(), connectToAgent(), handleApiRequest(), handleBatchRpc(), handleSolveCaptcha(), handleTrpcRequest() (+9 more)

### Community 73 - "Community 73"
Cohesion: 0.20
Nodes (17): composerBox(), composerSettingsButton(), ease(), humanClick(), humanMove(), mediaIdOf(), pageImages(), pageTiles() (+9 more)

### Community 74 - "Community 74"
Cohesion: 0.12
Nodes (16): action, default_title, background, service_worker, content_scripts, declarative_net_request, rule_resources, description (+8 more)

### Community 75 - "Community 75"
Cohesion: 0.13
Nodes (17): fromBool(), toBool(), getSetting(), getSite(), getSiteByDomain(), listBufferAccountRows(), listBufferAccounts(), setAutoPublish() (+9 more)

### Community 76 - "Community 76"
Cohesion: 0.12
Nodes (16): asContentType(), createReel(), deletePresenter(), insertKeyword(), insertPresenter(), listPresenters(), listScenes(), loadKeywordViews() (+8 more)

### Community 77 - "Community 77"
Cohesion: 0.17
Nodes (14): routeOf(), checkPlatformRules(), LinkMode, LINKS, listPlatformRules(), loadPlatformRules(), MEASURES, parseLimits() (+6 more)

### Community 79 - "Community 79"
Cohesion: 0.25
Nodes (16): captureTokenFromFlowTab(), closeIdleFlowTab(), collectDiagnostics(), discoverImageModels(), ensureFlowTabOnProject(), findProjectUrl(), flowTabLikelyExists(), handleSwitchAccount() (+8 more)

### Community 80 - "Community 80"
Cohesion: 0.21
Nodes (15): checkMediaToken(), DEFAULT_LINK_DAYS, linkDays(), MAX_LINK_DAYS, MediaCheck, mediaKey(), MediaKind, mediaPath() (+7 more)

### Community 81 - "Community 81"
Cohesion: 0.19
Nodes (14): FacebookPage, InstagramAccount, ThreadsProfile, Platform, ChannelLookups, Draft, drafts, realLookups (+6 more)

### Community 82 - "Community 82"
Cohesion: 0.19
Nodes (14): answerError(), askSearch(), call(), Locale, log, parseKeyLine(), providerOf(), RETRY_MS (+6 more)

### Community 83 - "Community 83"
Cohesion: 0.18
Nodes (15): _classifyApiUrl(), ensureHydrated(), goToProject(), init(), isDeadProjectPage(), isOnProject(), isRecaptchaRejection(), landWhereTheWorkIs() (+7 more)

### Community 84 - "Community 84"
Cohesion: 0.23
Nodes (13): articleGapMinutes(), claimSocialSlot(), GapSite, lastSocialSent(), letThrough, randomGapMinutes(), resetSocialSlots(), seededUnit() (+5 more)

### Community 85 - "Community 85"
Cohesion: 0.20
Nodes (6): BrowserProxyOptions, log, parseTarget(), registerBrowserProxy(), unreachablePage(), SECRET

### Community 86 - "Community 86"
Cohesion: 0.24
Nodes (10): capture(), test_an_explicit_model_key_overrides_the_table(), test_body_is_the_v2_batch_wrapper(), test_captcha_action_is_requested(), test_every_reference_is_tagged_as_an_asset(), test_model_comes_from_the_table_for_the_configured_tier(), test_portrait_is_the_default_for_reels(), test_prompt_is_wrapped_in_a_structured_prompt() (+2 more)

### Community 87 - "Community 87"
Cohesion: 0.24
Nodes (10): listEndpointRows(), automationOn(), automationOnAt(), automationBar(), startSignIn(), imageCatalogue(), body(), platformReady() (+2 more)

### Community 88 - "Community 88"
Cohesion: 0.24
Nodes (12): B(), C(), D(), G(), m(), na(), O(), oa() (+4 more)

### Community 89 - "Community 89"
Cohesion: 0.17
Nodes (12): Origin, PHASES, ResearchRow, ResearchState, callsMade(), searchKeysSection(), STATUS, TAG (+4 more)

### Community 90 - "Community 90"
Cohesion: 0.26
Nodes (6): reel_request(), inner_of(), test_a_request_needs_at_least_one_image(), test_no_presenter_leaves_both_slots_null_not_missing(), test_several_images_each_take_their_own_entry(), test_the_request_matches_the_capture_slot_for_slot()

### Community 91 - "Community 91"
Cohesion: 0.32
Nodes (11): escHtml(), fetchLog(), fetchStatus(), formatTime(), formatType(), _logEntries, showRequestDetail(), truncate() (+3 more)

### Community 92 - "Community 92"
Cohesion: 0.17
Nodes (11): ContentType, Decision, DecisionKind, KeywordView, LinkStatus, LinkView, PublishingTask, SelectionResult (+3 more)

### Community 93 - "Community 93"
Cohesion: 0.29
Nodes (4): ThreadsClient, ThreadsError, realThreads(), realRenew()

### Community 94 - "Community 94"
Cohesion: 0.22
Nodes (11): clearCommentApi(), deleteChannel(), body(), isOf(), letters(), newDraft(), on(), registerChannelRoutes() (+3 more)

### Community 95 - "Community 95"
Cohesion: 0.31
Nodes (9): BADGE, count(), homePage(), homeStages(), HomeState, plural(), Stage, StageState (+1 more)

### Community 96 - "Community 96"
Cohesion: 0.33
Nodes (6): cleanAllTraps(), cleanTrap(), installCapture(), savePristine(), watchEnterprise(), watchExecute()

### Community 97 - "Community 97"
Cohesion: 0.33
Nodes (10): inventedIngredients(), checkImageSet(), hasAllWords(), actionsIn(), checkSkeleton(), hasAllWords(), ownWords(), sectionWords() (+2 more)

### Community 98 - "Community 98"
Cohesion: 0.40
Nodes (10): apiTokenField(), base(), checkStep(), connectStep(), draftInput(), pickStep(), planStep(), postStep() (+2 more)

### Community 99 - "Community 99"
Cohesion: 0.42
Nodes (6): ExpandOptions, expandSeeds(), parseSuggestResponse(), suggest(), SUGGEST_MODIFIERS, SuggestOptions

### Community 100 - "Community 100"
Cohesion: 0.29
Nodes (8): classifyTerminalCaptchaError(), ensureFlowTab(), isContentsAccessError(), isFlowUrl(), isRecoverableTransportError(), requestCaptchaFromTab(), solveCaptcha(), waitForFlowTabReady()

### Community 101 - "Community 101"
Cohesion: 0.48
Nodes (6): badgeHtml(), escHtml(), formatTime(), formatType(), renderLog(), TYPE_LABELS

### Community 102 - "Community 102"
Cohesion: 0.43
Nodes (3): CommentApi, commentOn(), PostLinkDeps

### Community 103 - "Community 103"
Cohesion: 0.33
Nodes (3): LLM_REPLIES, RECIPE, WorldOptions

### Community 104 - "Community 104"
Cohesion: 0.40
Nodes (4): ja(), sa(), V(), c()

### Community 105 - "Community 105"
Cohesion: 0.67
Nodes (3): DBUS_SESSION_BUS_ADDRESS, fail(), entrypoint.sh script

### Community 106 - "Community 106"
Cohesion: 0.50
Nodes (4): countKeywordsMatching(), keywordViewCounts(), keywordWhere(), searchKeywords()

### Community 107 - "Community 107"
Cohesion: 0.83
Nodes (3): escape(), inline(), markdownToHtml()

### Community 108 - "Community 108"
Cohesion: 0.67
Nodes (3): D6(), KP(), N()

### Community 109 - "Community 109"
Cohesion: 0.67
Nodes (3): ResearchDeps, ResearchRouteDeps, SearchDeps

## Knowledge Gaps
- **1 isolated node(s):** `DBUS_SESSION_BUS_ADDRESS`
  These have ≤1 connection - possible missing edges. (Counts symbols only; 1018 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **11 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `run()` connect `Community 0` to `Community 2`, `Community 4`, `Community 5`, `Community 6`, `Community 7`, `Community 12`, `Community 15`, `Community 20`, `Community 23`, `Community 25`, `Community 26`, `Community 32`, `Community 34`, `Community 35`, `Community 44`, `Community 47`, `Community 53`, `Community 55`, `Community 58`, `Community 61`, `Community 62`, `Community 65`, `Community 67`, `Community 68`, `Community 75`, `Community 76`, `Community 81`, `Community 82`, `Community 84`, `Community 87`, `Community 94`?**
  _High betweenness centrality (0.044) - this node is a cross-community bridge._
- **What connects `DBUS_SESSION_BUS_ADDRESS` to the rest of the system?**
  _1 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.038461538461538464 - nodes in this community are weakly interconnected._
- **Why does `Html` connect `Community 42` to `Community 98`, `Community 66`, `Community 2`, `Community 67`, `Community 68`, `Community 39`, `Community 7`, `Community 69`, `Community 12`, `Community 18`, `Community 51`, `Community 55`, `Community 87`, `Community 24`, `Community 89`, `Community 56`, `Community 25`, `Community 95`?**
  _High betweenness centrality (0.042) - this node is a cross-community bridge._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.04908424908424908 - nodes in this community are weakly interconnected._
- **Why does `state()` connect `Community 42` to `Community 72`, `Community 79`, `Community 31`?**
  _High betweenness centrality (0.033) - this node is a cross-community bridge._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.0519219736087206 - nodes in this community are weakly interconnected._