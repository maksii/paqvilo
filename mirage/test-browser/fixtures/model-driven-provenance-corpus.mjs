// Invented browser scenario inputs and independently reviewed owner/source truth.
// Registry fixtures test the production read capability; they do not claim live native or Mirage render parity.
export default [
  {
    "id": "active-form-and-control-after-old-global-caps",
    "category": "active-metadata",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000003105",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "form",
        "predicate": "enclosingForm",
        "object": "form:10000000-0000-4000-8000-000000001205",
        "via": "mirage.host.binding",
        "origin": "observed"
      }
    ],
    "transport": {
      "catalogueRef": "../large-index.json",
      "request": {
        "revision": {
          "navigation": "navigation:1",
          "document": "document:1",
          "frame": "frame:top",
          "observation": "observation:1",
          "metadata": "metadata:1",
          "request": "request:1"
        },
        "active": {
          "table": "table:fixture_case",
          "form": "form:10000000-0000-4000-8000-000000001205",
          "controls": [
            "control:10000000-0000-4000-8000-000000003105"
          ]
        },
        "byteBudget": 16384,
        "itemBudget": 12
      },
      "expectedResponse": {
        "include": [
          "form:10000000-0000-4000-8000-000000001205",
          "control:10000000-0000-4000-8000-000000003105"
        ],
        "omitArbitraryPrefix": true,
        "bounded": true,
        "revision": {
          "navigation": "navigation:1",
          "document": "document:1",
          "frame": "frame:top",
          "observation": "observation:1",
          "metadata": "metadata:1",
          "request": "request:1"
        },
        "evidenceId": "response"
      }
    },
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "exact",
      "source": "exact",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "bounded-response-defers-source-retains-exact-owner",
    "category": "active-metadata",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000003105",
        "via": "mirage.host.binding",
        "origin": "observed"
      }
    ],
    "transport": {
      "request": {
        "revision": {
          "navigation": "navigation:1",
          "document": "document:1",
          "frame": "frame:top",
          "observation": "observation:1",
          "metadata": "metadata:1",
          "request": "request:1"
        },
        "componentRefs": [
          "control:10000000-0000-4000-8000-000000003105"
        ],
        "byteBudget": 128
      },
      "expectedResponse": {
        "ownerPreserved": true,
        "sourceAvailability": "deferred",
        "continuation": "opaque-fixture-token",
        "evidenceId": "budget",
        "noPartialXml": true
      }
    },
    "previousExpected": {
      "owner": "exact",
      "source": "unavailable"
    },
    "truth": {
      "owner": "exact",
      "source": "unavailable",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "active-header-footer-tab-structure-must-not-be-dropped",
    "category": "active-metadata",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000033",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "control:10000000-0000-4000-8000-000000000033",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
          "selector": "control:10000000-0000-4000-8000-000000000033",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "form",
        "predicate": "enclosingForm",
        "object": "form:10000000-0000-4000-8000-000000000001",
        "via": "mirage.host.binding",
        "origin": "observed"
      }
    ],
    "transport": {
      "request": {
        "revision": {
          "navigation": "navigation:1",
          "document": "document:1",
          "frame": "frame:top",
          "observation": "observation:1",
          "metadata": "metadata:1",
          "request": "request:1"
        },
        "active": {
          "form": "form:10000000-0000-4000-8000-000000000001",
          "controls": [
            "control:10000000-0000-4000-8000-000000000033"
          ]
        },
        "includeStructure": true
      },
      "expectedResponse": {
        "includeRegions": [
          "header",
          "footer",
          "body"
        ],
        "includeTabs": [
          "fixture_general"
        ],
        "includeSections": [
          "fixture_details"
        ],
        "includeControlUniqueIds": [
          "10000000-0000-4000-8000-000000000033",
          "10000000-0000-4000-8000-000000000034",
          "10000000-0000-4000-8000-000000000031"
        ],
        "revision": {
          "navigation": "navigation:1",
          "document": "document:1",
          "frame": "frame:top",
          "observation": "observation:1",
          "metadata": "metadata:1",
          "request": "request:1"
        }
      }
    },
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "exact",
      "source": "exact",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "active-view-after-old-view-cap-is-prioritized",
    "category": "active-metadata",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "currentView",
        "object": "view:10000000-0000-4000-8000-000000004205",
        "via": "mirage.host.binding",
        "origin": "observed"
      }
    ],
    "transport": {
      "catalogueRef": "../large-index.json",
      "request": {
        "revision": {
          "navigation": "navigation:1",
          "document": "document:1",
          "frame": "frame:top",
          "observation": "observation:1",
          "metadata": "metadata:1",
          "request": "request:1"
        },
        "active": {
          "table": "table:fixture_case",
          "view": "view:10000000-0000-4000-8000-000000004205"
        },
        "byteBudget": 4096,
        "itemBudget": 4
      },
      "expectedResponse": {
        "include": [
          "view:10000000-0000-4000-8000-000000004205"
        ],
        "omitArbitraryPrefix": true,
        "bounded": true,
        "evidenceId": "response",
        "revision": {
          "navigation": "navigation:1",
          "document": "document:1",
          "frame": "frame:top",
          "observation": "observation:1",
          "metadata": "metadata:1",
          "request": "request:1"
        }
      }
    },
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "exact",
      "source": "exact",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "exported-command-exact-host-binding",
    "category": "commands-resources",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "command:Fixture.Submit",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "command:Fixture.Submit",
          "file": "Solutions/Fixture/Entities/fixture_case/RibbonDiff.xml",
          "selector": "command:Fixture.Submit",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "form",
        "predicate": "enclosingForm",
        "object": "form:10000000-0000-4000-8000-000000000001",
        "via": "mirage.host.binding",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "exact",
      "source": "exact",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "oob-command-exact-owner-export-source-unavailable",
    "category": "commands-resources",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "command:platform.save",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "kind",
        "predicate": "sourceKind",
        "object": "platform",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "form",
        "predicate": "enclosingForm",
        "object": "form:10000000-0000-4000-8000-000000000001",
        "via": "mirage.host.binding",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "unavailable"
    },
    "truth": {
      "owner": "exact",
      "source": "unavailable",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "native-command-dom-token-only-heuristic",
    "category": "commands-resources",
    "host": "native",
    "facts": [
      {
        "id": "token",
        "predicate": "domCommandToken",
        "object": "Fixture.Submit",
        "via": "dom.attribute",
        "origin": "observed"
      },
      {
        "id": "matches",
        "predicate": "commandToken",
        "object": "Fixture.Submit",
        "via": "solution.metadata",
        "origin": "configured"
      }
    ],
    "previousExpected": {
      "owner": "candidate",
      "source": "candidate"
    },
    "truth": {
      "owner": "candidate",
      "source": "unavailable",
      "rationale": "A DOM command token is a candidate control hint; it does not bind an exported command implementation."
    }
  },
  {
    "id": "loaded-resource-declared-content-and-source-exact",
    "category": "commands-resources",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "resource:fixture_script.js",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "resource:fixture_script.js",
          "file": "Solutions/Fixture/WebResources/fixture_script.js",
          "selector": "resource:fixture_script.js",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "loaded",
        "predicate": "loadedResourceRevision",
        "object": "asset:sha256-invented-1",
        "via": "mirage.host.binding",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "exact",
      "source": "exact",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "similar-resource-basename-is-not-declared-resource",
    "category": "commands-resources",
    "host": "native",
    "facts": [
      {
        "id": "request",
        "predicate": "resourceBasename",
        "object": "fixture_script.js",
        "via": "resource-timing.basename",
        "origin": "observed"
      },
      {
        "id": "matches",
        "predicate": "declaredBasename",
        "object": "fixture_script.js",
        "via": "solution.metadata",
        "origin": "configured"
      }
    ],
    "previousExpected": {
      "owner": "candidate",
      "source": "candidate"
    },
    "truth": {
      "owner": "unavailable",
      "source": "unavailable",
      "rationale": "This fixture supplies context, requested input or page hints without a supported selected-node association. Preserve context and expose owner/source unavailability."
    }
  },
  {
    "id": "hashed-resource-requires-exact-declared-asset-join",
    "category": "commands-resources",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "resource:fixture_script.js",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "resource:fixture_script.js",
          "file": "Solutions/Fixture/WebResources/fixture_script.js",
          "selector": "resource:fixture_script.js",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "loaded",
        "predicate": "declaredResourceAsset",
        "object": {
          "resource": "fixture_script.js",
          "asset": "fixture_script.7b41d2.js",
          "revision": "asset:sha256-invented-1"
        },
        "via": "mirage.http.resourceManifest",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "exact",
      "source": "exact",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "two-current-host-bindings-conflict",
    "category": "conflicts-boundaries",
    "host": "mirage",
    "facts": [
      {
        "id": "host1",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000031",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "host2",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000032",
        "via": "mirage.host.binding",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "conflicting",
      "source": "conflicting"
    },
    "truth": {
      "owner": "conflicting",
      "source": "unavailable",
      "rationale": "Two current host owners disagree. Neither observation supplies definition bytes, so source evidence remains unavailable."
    }
  },
  {
    "id": "host-binding-wins-over-dom-name-heuristic",
    "category": "conflicts-boundaries",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000033",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "control:10000000-0000-4000-8000-000000000033",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
          "selector": "control:10000000-0000-4000-8000-000000000033",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "token",
        "predicate": "attributeName",
        "object": "fixture_title",
        "via": "dom.attribute",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "exact",
      "source": "exact",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "same-component-layer-source-conflict",
    "category": "conflicts-boundaries",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000031",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "control:10000000-0000-4000-8000-000000000031",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
          "selector": "control:10000000-0000-4000-8000-000000000031",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "source2",
        "predicate": "exportSource",
        "object": {
          "componentRef": "control:10000000-0000-4000-8000-000000000031",
          "file": "Solutions/FixtureAlternative/Entities/fixture_case/FormXml/main/form.xml",
          "selector": "control:10000000-0000-4000-8000-000000000031",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "conflicting"
    },
    "truth": {
      "owner": "exact",
      "source": "conflicting",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "trusted-layer-order-resolves-source",
    "category": "conflicts-boundaries",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000031",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "control:10000000-0000-4000-8000-000000000031",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
          "selector": "control:10000000-0000-4000-8000-000000000031",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "layer",
        "predicate": "effectiveLayer",
        "object": {
          "sourceRef": {
            "componentRef": "control:10000000-0000-4000-8000-000000000031",
            "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
            "selector": "control:10000000-0000-4000-8000-000000000031",
            "revision": "metadata:1"
          },
          "orderVerified": true
        },
        "via": "solution.metadata",
        "origin": "configured"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "exact",
      "source": "exact",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "out-of-origin-provider-response-refused",
    "category": "conflicts-boundaries",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000031",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "control:10000000-0000-4000-8000-000000000031",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
          "selector": "control:10000000-0000-4000-8000-000000000031",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      }
    ],
    "transport": {
      "requestScope": "loopback-fixture",
      "responseScope": "unrelated-origin-fixture",
      "admission": "reject-before-merge"
    },
    "previousExpected": {
      "owner": "unavailable",
      "source": "unavailable"
    },
    "truth": {
      "owner": "unavailable",
      "source": "unavailable",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "forged-page-binding-not-mirage-host-authority",
    "category": "conflicts-boundaries",
    "host": "native",
    "facts": [
      {
        "id": "forged",
        "predicate": "domBindingToken",
        "object": "control:10000000-0000-4000-8000-000000000031",
        "via": "dom.attribute",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "candidate",
      "source": "unavailable"
    },
    "truth": {
      "owner": "unavailable",
      "source": "unavailable",
      "rationale": "This fixture supplies context, requested input or page hints without a supported selected-node association. Preserve context and expose owner/source unavailability."
    }
  },
  {
    "id": "unique-control-body",
    "category": "controls",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000031",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "control:10000000-0000-4000-8000-000000000031",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
          "selector": "control:10000000-0000-4000-8000-000000000031",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "form",
        "predicate": "enclosingForm",
        "object": "form:10000000-0000-4000-8000-000000000001",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "table",
        "predicate": "enclosingTable",
        "object": "table:fixture_case",
        "via": "mirage.host.binding",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "exact",
      "source": "exact",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "unique-control-duplicate",
    "category": "controls",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000032",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "control:10000000-0000-4000-8000-000000000032",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
          "selector": "control:10000000-0000-4000-8000-000000000032",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "form",
        "predicate": "enclosingForm",
        "object": "form:10000000-0000-4000-8000-000000000001",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "table",
        "predicate": "enclosingTable",
        "object": "table:fixture_case",
        "via": "mirage.host.binding",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "exact",
      "source": "exact",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "unique-control-header",
    "category": "controls",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000033",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "control:10000000-0000-4000-8000-000000000033",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
          "selector": "control:10000000-0000-4000-8000-000000000033",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "form",
        "predicate": "enclosingForm",
        "object": "form:10000000-0000-4000-8000-000000000001",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "table",
        "predicate": "enclosingTable",
        "object": "table:fixture_case",
        "via": "mirage.host.binding",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "exact",
      "source": "exact",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "unique-control-footer",
    "category": "controls",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000034",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "control:10000000-0000-4000-8000-000000000034",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
          "selector": "control:10000000-0000-4000-8000-000000000034",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "form",
        "predicate": "enclosingForm",
        "object": "form:10000000-0000-4000-8000-000000000001",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "table",
        "predicate": "enclosingTable",
        "object": "table:fixture_case",
        "via": "mirage.host.binding",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "exact",
      "source": "exact",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "unique-control-bpf",
    "category": "controls",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000035",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "control:10000000-0000-4000-8000-000000000035",
          "file": "Solutions/Fixture/Workflows/FixtureProcess.xml",
          "selector": "control:10000000-0000-4000-8000-000000000035",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "form",
        "predicate": "enclosingForm",
        "object": "form:10000000-0000-4000-8000-000000000001",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "table",
        "predicate": "enclosingTable",
        "object": "table:fixture_case",
        "via": "mirage.host.binding",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "exact",
      "source": "unavailable",
      "rationale": "The registry fixture knows the BPF node owner; this FormXml index contains no verified workflow placement. Do not reuse another field occurrence."
    }
  },
  {
    "id": "duplicate-field-name-only-cannot-choose-control",
    "category": "controls",
    "host": "native",
    "facts": [
      {
        "id": "name",
        "predicate": "attributeName",
        "object": "fixture_title",
        "via": "dom.attribute",
        "origin": "observed"
      },
      {
        "id": "matches",
        "predicate": "attributeControls",
        "object": [
          "control:10000000-0000-4000-8000-000000000031",
          "control:10000000-0000-4000-8000-000000000032",
          "control:10000000-0000-4000-8000-000000000033",
          "control:10000000-0000-4000-8000-000000000034",
          "control:10000000-0000-4000-8000-000000000035"
        ],
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "form",
        "predicate": "enclosingForm",
        "object": "form:10000000-0000-4000-8000-000000000001",
        "via": "formContext.ui.formSelector.getCurrentItem.getId",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "candidate",
      "source": "candidate"
    },
    "truth": {
      "owner": "candidate",
      "source": "candidate",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "native-unique-control-name-and-current-form",
    "category": "controls",
    "host": "native",
    "facts": [
      {
        "id": "control",
        "predicate": "domControlName",
        "object": "header_fixture_title",
        "via": "dom.attribute",
        "origin": "observed"
      },
      {
        "id": "join",
        "predicate": "controlNameMatch",
        "object": "control:10000000-0000-4000-8000-000000000033",
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "control:10000000-0000-4000-8000-000000000033",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
          "selector": "control:10000000-0000-4000-8000-000000000033",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "form",
        "predicate": "enclosingForm",
        "object": "form:10000000-0000-4000-8000-000000000001",
        "via": "formContext.ui.formSelector.getCurrentItem.getId",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "candidate",
      "source": "candidate"
    },
    "truth": {
      "owner": "candidate",
      "source": "candidate",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "field-owner-known-source-not-loaded",
    "category": "controls",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000031",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "missing",
        "predicate": "metadataAvailability",
        "object": "not-requested",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "form",
        "predicate": "enclosingForm",
        "object": "form:10000000-0000-4000-8000-000000000001",
        "via": "mirage.host.binding",
        "origin": "observed"
      }
    ],
    "transport": {
      "selectionRequest": {
        "componentRefs": [
          "control:10000000-0000-4000-8000-000000000031"
        ],
        "revision": {
          "navigation": "navigation:1",
          "document": "document:1",
          "frame": "frame:top",
          "observation": "observation:1",
          "metadata": "metadata:1",
          "request": "request:1"
        }
      },
      "expectedResponse": {
        "preserveOwner": true,
        "sourceStatus": "exact",
        "sourceRefs": [
          {
            "componentRef": "control:10000000-0000-4000-8000-000000000031",
            "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
            "selector": "control:10000000-0000-4000-8000-000000000031",
            "revision": "metadata:1"
          }
        ],
        "revision": {
          "navigation": "navigation:1",
          "document": "document:1",
          "frame": "frame:top",
          "observation": "observation:1",
          "metadata": "metadata:1",
          "request": "request:1"
        }
      }
    },
    "previousExpected": {
      "owner": "exact",
      "source": "unavailable"
    },
    "truth": {
      "owner": "exact",
      "source": "unavailable",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "native-form-type-is-operation-not-form-definition-type",
    "category": "controls",
    "host": "native",
    "facts": [
      {
        "id": "mode",
        "predicate": "operationFormType",
        "object": 1,
        "via": "formContext.ui.getFormType",
        "origin": "observed"
      },
      {
        "id": "forms",
        "predicate": "formDefinitions",
        "object": [
          {
            "ref": "form:10000000-0000-4000-8000-000000000001",
            "systemFormType": 2
          },
          {
            "ref": "form:10000000-0000-4000-8000-000000000003",
            "systemFormType": 7
          }
        ],
        "via": "solution.metadata",
        "origin": "configured"
      }
    ],
    "previousExpected": {
      "owner": "candidate",
      "source": "candidate"
    },
    "truth": {
      "owner": "unavailable",
      "source": "unavailable",
      "rationale": "This fixture supplies context, requested input or page hints without a supported selected-node association. Preserve context and expose owner/source unavailability."
    }
  },
  {
    "id": "selected-table-component-has-entity-source",
    "category": "controls",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "table:fixture_case",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "table:fixture_case",
          "file": "Solutions/Fixture/Entities/fixture_case/Entity.xml",
          "selector": "table:fixture_case",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "exact",
      "source": "exact",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "source-reference-known-file-unavailable",
    "category": "controls",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000031",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "control:10000000-0000-4000-8000-000000000031",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
          "selector": "control:10000000-0000-4000-8000-000000000031",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "file",
        "predicate": "sourceRead",
        "object": {
          "state": "unavailable",
          "code": "SOURCE_FILE_MISSING"
        },
        "via": "controller.source.read",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "unavailable"
    },
    "truth": {
      "owner": "exact",
      "source": "unavailable",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "main-form-explicit-host-owner",
    "category": "forms",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "form:10000000-0000-4000-8000-000000000001",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "form:10000000-0000-4000-8000-000000000001",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
          "selector": "form:10000000-0000-4000-8000-000000000001",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "table",
        "predicate": "enclosingTable",
        "object": "table:fixture_case",
        "via": "mirage.host.binding",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "exact",
      "source": "exact",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "native-current-form-selector-main",
    "category": "forms",
    "host": "native",
    "facts": [
      {
        "id": "owner",
        "predicate": "currentForm",
        "object": "form:10000000-0000-4000-8000-000000000001",
        "via": "formContext.ui.formSelector.getCurrentItem.getId",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "form:10000000-0000-4000-8000-000000000001",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
          "selector": "form:10000000-0000-4000-8000-000000000001",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "unavailable",
      "source": "unavailable",
      "rationale": "This fixture supplies context, requested input or page hints without a supported selected-node association. Preserve context and expose owner/source unavailability."
    }
  },
  {
    "id": "native-single-form-selector-null",
    "category": "forms",
    "host": "native",
    "facts": [
      {
        "id": "selector",
        "predicate": "currentFormSelector",
        "object": {
          "state": "null"
        },
        "via": "formContext.ui.formSelector.getCurrentItem",
        "origin": "observed"
      },
      {
        "id": "forms",
        "predicate": "exportedForms",
        "object": [
          "form:10000000-0000-4000-8000-000000000001"
        ],
        "via": "solution.metadata",
        "origin": "configured"
      }
    ],
    "previousExpected": {
      "owner": "candidate",
      "source": "candidate"
    },
    "truth": {
      "owner": "unavailable",
      "source": "unavailable",
      "rationale": "This fixture supplies context, requested input or page hints without a supported selected-node association. Preserve context and expose owner/source unavailability."
    }
  },
  {
    "id": "native-null-selector-unique-structural-current-match",
    "category": "forms",
    "host": "native",
    "facts": [
      {
        "id": "selector",
        "predicate": "currentFormSelector",
        "object": {
          "state": "null"
        },
        "via": "formContext.ui.formSelector.getCurrentItem",
        "origin": "observed"
      },
      {
        "id": "structure",
        "predicate": "currentControlStructure",
        "object": {
          "controls": [
            "fixture_title",
            "fixture_title1",
            "fixture_scalar",
            "header_fixture_title",
            "footer_fixture_title"
          ],
          "complete": true
        },
        "via": "formContext.ui.controls.get",
        "origin": "observed"
      },
      {
        "id": "structures",
        "predicate": "formControlStructures",
        "object": [
          {
            "form": "form:10000000-0000-4000-8000-000000000001",
            "controls": [
              "fixture_title",
              "fixture_title1",
              "fixture_scalar",
              "header_fixture_title",
              "footer_fixture_title"
            ],
            "complete": true
          },
          {
            "form": "form:10000000-0000-4000-8000-000000000002",
            "controls": [
              "fixture_title"
            ],
            "complete": true
          }
        ],
        "via": "solution.metadata",
        "origin": "configured"
      }
    ],
    "previousExpected": {
      "owner": "candidate",
      "source": "candidate"
    },
    "truth": {
      "owner": "unavailable",
      "source": "unavailable",
      "rationale": "This fixture supplies context, requested input or page hints without a supported selected-node association. Preserve context and expose owner/source unavailability."
    }
  },
  {
    "id": "quick-create-selector-unsupported-input-id-only",
    "category": "forms",
    "host": "native",
    "facts": [
      {
        "id": "selector",
        "predicate": "currentFormSelector",
        "object": {
          "state": "unsupported"
        },
        "via": "formContext.ui.formSelector",
        "origin": "observed"
      },
      {
        "id": "input",
        "predicate": "requestedForm",
        "object": "form:10000000-0000-4000-8000-000000000003",
        "via": "Xrm.Utility.getPageContext",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "form:10000000-0000-4000-8000-000000000003",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/quickCreate/10000000-0000-4000-8000-000000000003.xml",
          "selector": "form:10000000-0000-4000-8000-000000000003",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      }
    ],
    "previousExpected": {
      "owner": "candidate",
      "source": "candidate"
    },
    "truth": {
      "owner": "unavailable",
      "source": "unavailable",
      "rationale": "This fixture supplies context, requested input or page hints without a supported selected-node association. Preserve context and expose owner/source unavailability."
    }
  },
  {
    "id": "quick-create-host-current-binding",
    "category": "forms",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "form:10000000-0000-4000-8000-000000000003",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "form:10000000-0000-4000-8000-000000000003",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/quickCreate/10000000-0000-4000-8000-000000000003.xml",
          "selector": "form:10000000-0000-4000-8000-000000000003",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "exact",
      "source": "exact",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "opening-form-id-disagrees-with-current-selector",
    "category": "forms",
    "host": "native",
    "facts": [
      {
        "id": "input",
        "predicate": "requestedForm",
        "object": "form:10000000-0000-4000-8000-000000000002",
        "via": "Xrm.Utility.getPageContext",
        "origin": "observed"
      },
      {
        "id": "owner",
        "predicate": "currentForm",
        "object": "form:10000000-0000-4000-8000-000000000001",
        "via": "formContext.ui.formSelector.getCurrentItem.getId",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "form:10000000-0000-4000-8000-000000000001",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
          "selector": "form:10000000-0000-4000-8000-000000000001",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "unavailable",
      "source": "unavailable",
      "rationale": "This fixture supplies context, requested input or page hints without a supported selected-node association. Preserve context and expose owner/source unavailability."
    }
  },
  {
    "id": "generated-form-exact-owner-no-export",
    "category": "forms",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "form:10000000-0000-4000-8000-000000000005",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "generated",
        "predicate": "sourceKind",
        "object": "generated",
        "via": "mirage.host.binding",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "unavailable"
    },
    "truth": {
      "owner": "exact",
      "source": "unavailable",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "form-context-is-not-selected-oob-shell-owner",
    "category": "forms",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "shell:command-bar",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "table",
        "predicate": "enclosingTable",
        "object": "table:fixture_case",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "form",
        "predicate": "enclosingForm",
        "object": "form:10000000-0000-4000-8000-000000000001",
        "via": "mirage.host.binding",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "unavailable"
    },
    "truth": {
      "owner": "exact",
      "source": "unavailable",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "native-incomplete-control-snapshot-cannot-prove-form",
    "category": "forms",
    "host": "native",
    "facts": [
      {
        "id": "structure",
        "predicate": "currentControlStructure",
        "object": {
          "controls": [
            "fixture_title"
          ],
          "complete": false,
          "truncation": "item-budget"
        },
        "via": "formContext.ui.controls.get",
        "origin": "observed"
      },
      {
        "id": "forms",
        "predicate": "exportedForms",
        "object": [
          "form:10000000-0000-4000-8000-000000000001",
          "form:10000000-0000-4000-8000-000000000002"
        ],
        "via": "solution.metadata",
        "origin": "configured"
      }
    ],
    "previousExpected": {
      "owner": "candidate",
      "source": "candidate"
    },
    "truth": {
      "owner": "unavailable",
      "source": "unavailable",
      "rationale": "This fixture supplies context, requested input or page hints without a supported selected-node association. Preserve context and expose owner/source unavailability."
    }
  },
  {
    "id": "same-origin-child-frame-direct-binding",
    "category": "frames-revisions",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000031",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "control:10000000-0000-4000-8000-000000000031",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
          "selector": "control:10000000-0000-4000-8000-000000000031",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "frame",
        "predicate": "frameIdentity",
        "object": {
          "frame": "frame:child",
          "document": "document:child:1",
          "parent": "frame:top"
        },
        "via": "mirage.host.binding",
        "origin": "observed"
      }
    ],
    "transport": {
      "requestRevision": {
        "navigation": "navigation:1",
        "document": "document:child:1",
        "frame": "frame:child",
        "observation": "observation:1",
        "metadata": "metadata:1",
        "request": "request:1"
      },
      "responseRevision": {
        "navigation": "navigation:1",
        "document": "document:child:1",
        "frame": "frame:child",
        "observation": "observation:1",
        "metadata": "metadata:1",
        "request": "request:1"
      },
      "admission": "accept"
    },
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "exact",
      "source": "exact",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "nested-cross-origin-frame-boundary",
    "category": "frames-revisions",
    "host": "native",
    "facts": [
      {
        "id": "boundary",
        "predicate": "access",
        "object": {
          "state": "cross-origin-denied",
          "parent": "frame:child"
        },
        "via": "frame.access",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "unavailable",
      "source": "unavailable"
    },
    "truth": {
      "owner": "unavailable",
      "source": "unavailable",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "navigation-while-source-response-in-flight",
    "category": "frames-revisions",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000031",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "control:10000000-0000-4000-8000-000000000031",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
          "selector": "control:10000000-0000-4000-8000-000000000031",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      }
    ],
    "transport": {
      "requestRevision": {
        "navigation": "navigation:1",
        "document": "document:1",
        "frame": "frame:top",
        "observation": "observation:1",
        "metadata": "metadata:1",
        "request": "request:1"
      },
      "currentRevision": {
        "navigation": "navigation:2",
        "document": "document:2",
        "frame": "frame:top",
        "observation": "observation:1",
        "metadata": "metadata:1",
        "request": "request:1"
      },
      "responseRevision": {
        "navigation": "navigation:1",
        "document": "document:1",
        "frame": "frame:top",
        "observation": "observation:1",
        "metadata": "metadata:1",
        "request": "request:1"
      },
      "admission": "reject",
      "preserveCurrentSelection": true
    },
    "previousExpected": {
      "owner": "stale",
      "source": "stale"
    },
    "truth": {
      "owner": "stale",
      "source": "stale",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "frame-replaced-same-frame-name",
    "category": "frames-revisions",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000031",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "control:10000000-0000-4000-8000-000000000031",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
          "selector": "control:10000000-0000-4000-8000-000000000031",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      }
    ],
    "transport": {
      "requestRevision": {
        "navigation": "navigation:1",
        "document": "document:1",
        "frame": "frame:top",
        "observation": "observation:1",
        "metadata": "metadata:1",
        "request": "request:1"
      },
      "currentRevision": {
        "navigation": "navigation:1",
        "document": "document:replacement",
        "frame": "frame:top",
        "observation": "observation:1",
        "metadata": "metadata:1",
        "request": "request:1"
      },
      "responseRevision": {
        "navigation": "navigation:1",
        "document": "document:1",
        "frame": "frame:top",
        "observation": "observation:1",
        "metadata": "metadata:1",
        "request": "request:1"
      },
      "admission": "reject",
      "preserveCurrentSelection": true
    },
    "previousExpected": {
      "owner": "stale",
      "source": "stale"
    },
    "truth": {
      "owner": "stale",
      "source": "stale",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "metadata-reloaded-during-selection",
    "category": "frames-revisions",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000031",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "control:10000000-0000-4000-8000-000000000031",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
          "selector": "control:10000000-0000-4000-8000-000000000031",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      }
    ],
    "transport": {
      "requestRevision": {
        "navigation": "navigation:1",
        "document": "document:1",
        "frame": "frame:top",
        "observation": "observation:1",
        "metadata": "metadata:1",
        "request": "request:1"
      },
      "currentRevision": {
        "navigation": "navigation:1",
        "document": "document:1",
        "frame": "frame:top",
        "observation": "observation:1",
        "metadata": "metadata:2",
        "request": "request:1"
      },
      "responseRevision": {
        "navigation": "navigation:1",
        "document": "document:1",
        "frame": "frame:top",
        "observation": "observation:1",
        "metadata": "metadata:1",
        "request": "request:1"
      },
      "admission": "reject-source-preserve-owner"
    },
    "previousExpected": {
      "owner": "exact",
      "source": "stale"
    },
    "truth": {
      "owner": "exact",
      "source": "stale",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "older-selection-response-after-new-selection",
    "category": "frames-revisions",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000031",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "control:10000000-0000-4000-8000-000000000031",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
          "selector": "control:10000000-0000-4000-8000-000000000031",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      }
    ],
    "transport": {
      "requestRevision": {
        "navigation": "navigation:1",
        "document": "document:1",
        "frame": "frame:top",
        "observation": "observation:1",
        "metadata": "metadata:1",
        "request": "request:1"
      },
      "currentRevision": {
        "navigation": "navigation:1",
        "document": "document:1",
        "frame": "frame:top",
        "observation": "observation:1",
        "metadata": "metadata:1",
        "request": "request:2"
      },
      "responseRevision": {
        "navigation": "navigation:1",
        "document": "document:1",
        "frame": "frame:top",
        "observation": "observation:1",
        "metadata": "metadata:1",
        "request": "request:1"
      },
      "admission": "reject",
      "preserveCurrentSelection": true
    },
    "previousExpected": {
      "owner": "stale",
      "source": "stale"
    },
    "truth": {
      "owner": "unavailable",
      "source": "unavailable",
      "rationale": "The actual controller refuses an obsolete anchor before merging its response; refusal does not relabel the current selection."
    }
  },
  {
    "id": "async-grid-load-preserves-grid-owner-not-old-view",
    "category": "frames-revisions",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000036",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "control:10000000-0000-4000-8000-000000000036",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
          "selector": "control:10000000-0000-4000-8000-000000000036",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "loading",
        "predicate": "viewLoad",
        "object": {
          "state": "pending",
          "generation": "grid:2"
        },
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "previous",
        "predicate": "priorView",
        "object": "view:10000000-0000-4000-8000-000000000011",
        "via": "mirage.host.binding",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "exact",
      "source": "exact",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "same-document-rerender-invalidates-old-node-binding",
    "category": "frames-revisions",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000031",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "control:10000000-0000-4000-8000-000000000031",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
          "selector": "control:10000000-0000-4000-8000-000000000031",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      }
    ],
    "transport": {
      "requestRevision": {
        "navigation": "navigation:1",
        "document": "document:1",
        "frame": "frame:top",
        "observation": "observation:1",
        "metadata": "metadata:1",
        "request": "request:1"
      },
      "currentRevision": {
        "navigation": "navigation:1",
        "document": "document:1",
        "frame": "frame:top",
        "observation": "observation:2",
        "metadata": "metadata:1",
        "request": "request:1"
      },
      "responseRevision": {
        "navigation": "navigation:1",
        "document": "document:1",
        "frame": "frame:top",
        "observation": "observation:1",
        "metadata": "metadata:1",
        "request": "request:1"
      },
      "admission": "reject",
      "preserveCurrentSelection": true
    },
    "previousExpected": {
      "owner": "stale",
      "source": "stale"
    },
    "truth": {
      "owner": "stale",
      "source": "stale",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "parent-frame-xrm-not-child-current-context",
    "category": "frames-revisions",
    "host": "native",
    "facts": [
      {
        "id": "parent",
        "predicate": "currentForm",
        "object": "form:10000000-0000-4000-8000-000000000001",
        "via": "parent.formContext.ui.formSelector.getCurrentItem.getId",
        "origin": "observed"
      },
      {
        "id": "child",
        "predicate": "frameIdentity",
        "object": {
          "frame": "frame:child",
          "document": "document:child:1"
        },
        "via": "frame.identity",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "unavailable",
      "source": "unavailable"
    },
    "truth": {
      "owner": "unavailable",
      "source": "unavailable",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "runtime-current-view-differs-from-configured-default",
    "category": "grids",
    "host": "native",
    "facts": [
      {
        "id": "owner",
        "predicate": "currentView",
        "object": "view:10000000-0000-4000-8000-000000000012",
        "via": "gridContext.getViewSelector.getCurrentView",
        "origin": "observed"
      },
      {
        "id": "default",
        "predicate": "configuredDefaultView",
        "object": "view:10000000-0000-4000-8000-000000000011",
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "view:10000000-0000-4000-8000-000000000012",
          "file": "Solutions/Fixture/Entities/fixture_case/SavedQueries/10000000-0000-4000-8000-000000000012.xml",
          "selector": "view:10000000-0000-4000-8000-000000000012",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "unavailable",
      "source": "unavailable",
      "rationale": "This fixture supplies context, requested input or page hints without a supported selected-node association. Preserve context and expose owner/source unavailability."
    }
  },
  {
    "id": "hidden-selector-throws-default-remains-candidate",
    "category": "grids",
    "host": "native",
    "facts": [
      {
        "id": "selector",
        "predicate": "viewSelectorRead",
        "object": {
          "state": "throws",
          "code": "VIEW_SELECTOR_HIDDEN"
        },
        "via": "gridContext.getViewSelector.getCurrentView",
        "origin": "observed"
      },
      {
        "id": "default",
        "predicate": "configuredDefaultView",
        "object": "view:10000000-0000-4000-8000-000000000011",
        "via": "solution.metadata",
        "origin": "configured"
      }
    ],
    "previousExpected": {
      "owner": "candidate",
      "source": "candidate"
    },
    "truth": {
      "owner": "unavailable",
      "source": "unavailable",
      "rationale": "This fixture supplies context, requested input or page hints without a supported selected-node association. Preserve context and expose owner/source unavailability."
    }
  },
  {
    "id": "page-context-view-only-is-opening-input",
    "category": "grids",
    "host": "native",
    "facts": [
      {
        "id": "input",
        "predicate": "requestedView",
        "object": "view:10000000-0000-4000-8000-000000000011",
        "via": "Xrm.Utility.getPageContext",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "candidate",
      "source": "candidate"
    },
    "truth": {
      "owner": "unavailable",
      "source": "unavailable",
      "rationale": "This fixture supplies context, requested input or page hints without a supported selected-node association. Preserve context and expose owner/source unavailability."
    }
  },
  {
    "id": "subgrid-owner-and-runtime-view-have-separate-sources",
    "category": "grids",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000036",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "control:10000000-0000-4000-8000-000000000036",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
          "selector": "control:10000000-0000-4000-8000-000000000036",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "view",
        "predicate": "currentView",
        "object": "view:10000000-0000-4000-8000-000000000012",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "default",
        "predicate": "configuredDefaultView",
        "object": "view:10000000-0000-4000-8000-000000000011",
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "form",
        "predicate": "enclosingForm",
        "object": "form:10000000-0000-4000-8000-000000000001",
        "via": "mirage.host.binding",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "exact",
      "source": "exact",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "quick-view-child-owner-keeps-enclosing-form-separate",
    "category": "grids",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:quick-view-child",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "quick",
        "predicate": "enclosingForm",
        "object": "form:10000000-0000-4000-8000-000000000004",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "control:quick-view-child",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/quick/10000000-0000-4000-8000-000000000004.xml",
          "selector": "control:quick-view-child",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "form",
        "predicate": "enclosingForm",
        "object": "form:10000000-0000-4000-8000-000000000001",
        "via": "mirage.host.binding",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "exact",
      "source": "exact",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "generated-view-exact-owner-no-export",
    "category": "grids",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "currentView",
        "object": "view:generated-view",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "generated",
        "predicate": "sourceKind",
        "object": "generated",
        "via": "mirage.host.binding",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "unavailable"
    },
    "truth": {
      "owner": "exact",
      "source": "unavailable",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "personal-view-current-owner-without-solution-source",
    "category": "grids",
    "host": "native",
    "facts": [
      {
        "id": "owner",
        "predicate": "currentView",
        "object": "view:10000000-0000-4000-8000-000000000014",
        "via": "gridContext.getViewSelector.getCurrentView",
        "origin": "observed"
      },
      {
        "id": "kind",
        "predicate": "viewKind",
        "object": "personal",
        "via": "gridContext.getViewSelector.getCurrentView",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "unavailable"
    },
    "truth": {
      "owner": "unavailable",
      "source": "unavailable",
      "rationale": "This fixture supplies context, requested input or page hints without a supported selected-node association. Preserve context and expose owner/source unavailability."
    }
  },
  {
    "id": "scalar-desktop-mounted",
    "category": "pcf",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000038",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "control:10000000-0000-4000-8000-000000000038",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
          "selector": "control:10000000-0000-4000-8000-000000000038",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "mount",
        "predicate": "mountedComponent",
        "object": {
          "componentRef": "pcf:Fixture.Scalar",
          "formFactor": 0,
          "state": "mounted"
        },
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "component-source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "pcf:Fixture.Scalar",
          "file": "Solutions/Fixture/Controls/Fixture.Scalar/ControlManifest.Input.xml",
          "selector": "pcf:Fixture.Scalar",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "exact",
      "source": "exact",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "scalar-phone-current-binding",
    "category": "pcf",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000038",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "control:10000000-0000-4000-8000-000000000038",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
          "selector": "control:10000000-0000-4000-8000-000000000038",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "mount",
        "predicate": "mountedComponent",
        "object": {
          "componentRef": "pcf:Fixture.Scalar",
          "formFactor": 2,
          "state": "mounted"
        },
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "component-source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "pcf:Fixture.Scalar",
          "file": "Solutions/Fixture/Controls/Fixture.Scalar/ControlManifest.Input.xml",
          "selector": "pcf:Fixture.Scalar",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "exact",
      "source": "exact",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "dataset-tablet-mounted",
    "category": "pcf",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000039",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "control:10000000-0000-4000-8000-000000000039",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
          "selector": "control:10000000-0000-4000-8000-000000000039",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "mount",
        "predicate": "mountedComponent",
        "object": {
          "componentRef": "pcf:Fixture.Dataset",
          "formFactor": 1,
          "state": "mounted"
        },
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "component-source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "pcf:Fixture.Dataset",
          "file": "Solutions/Fixture/Controls/Fixture.Dataset/ControlManifest.Input.xml",
          "selector": "pcf:Fixture.Dataset",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "exact",
      "source": "exact",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "configured-pcf-mount-failure-native-fallback",
    "category": "pcf",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000038",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "control:10000000-0000-4000-8000-000000000038",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
          "selector": "control:10000000-0000-4000-8000-000000000038",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "configured",
        "predicate": "configuredComponent",
        "object": "pcf:Fixture.Scalar",
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "mount",
        "predicate": "componentMount",
        "object": {
          "state": "failed",
          "code": "UNSUPPORTED_API"
        },
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "renderer",
        "predicate": "activeRenderer",
        "object": "native-fallback",
        "via": "mirage.host.binding",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "exact",
      "source": "unavailable",
      "rationale": "The actual selected fallback is a platform host. Its configured placement/PCF remain context; no exported implementation authored that fallback."
    }
  },
  {
    "id": "phone-binding-not-desktop-default",
    "category": "pcf",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000038",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "mount",
        "predicate": "mountedComponent",
        "object": {
          "componentRef": "pcf:Fixture.PhoneScalar",
          "formFactor": 2
        },
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "desktop",
        "predicate": "configuredComponent",
        "object": {
          "componentRef": "pcf:Fixture.Scalar",
          "formFactor": 0
        },
        "via": "solution.metadata",
        "origin": "configured"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "unavailable"
    },
    "truth": {
      "owner": "exact",
      "source": "unavailable",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "dataset-current-view-independent-from-binding-default",
    "category": "pcf",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000039",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "control:10000000-0000-4000-8000-000000000039",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
          "selector": "control:10000000-0000-4000-8000-000000000039",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "configured",
        "predicate": "configuredDatasetView",
        "object": "view:10000000-0000-4000-8000-000000000011",
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "current",
        "predicate": "currentDatasetView",
        "object": "view:10000000-0000-4000-8000-000000000012",
        "via": "mirage.host.binding",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "exact",
      "source": "exact",
      "rationale": "Current authoritative node bindings and real imported definition bytes are evaluated independently."
    }
  },
  {
    "id": "dataset-mount-failure-keeps-grid-owner-and-native-view",
    "category": "pcf",
    "host": "mirage",
    "facts": [
      {
        "id": "owner",
        "predicate": "selectedOwner",
        "object": "control:10000000-0000-4000-8000-000000000039",
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "source",
        "predicate": "exportSource",
        "object": {
          "componentRef": "control:10000000-0000-4000-8000-000000000039",
          "file": "Solutions/Fixture/Entities/fixture_case/FormXml/main/10000000-0000-4000-8000-000000000001.xml",
          "selector": "control:10000000-0000-4000-8000-000000000039",
          "revision": "metadata:1"
        },
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "configured",
        "predicate": "configuredComponent",
        "object": "pcf:Fixture.Dataset",
        "via": "solution.metadata",
        "origin": "configured"
      },
      {
        "id": "mount",
        "predicate": "componentMount",
        "object": {
          "state": "failed",
          "code": "MANIFEST_NOT_ADMITTED"
        },
        "via": "mirage.host.binding",
        "origin": "observed"
      },
      {
        "id": "view",
        "predicate": "currentView",
        "object": "view:10000000-0000-4000-8000-000000000011",
        "via": "mirage.host.binding",
        "origin": "observed"
      }
    ],
    "previousExpected": {
      "owner": "exact",
      "source": "exact"
    },
    "truth": {
      "owner": "exact",
      "source": "unavailable",
      "rationale": "The actual selected fallback is a platform host. Its configured placement/PCF remain context; no exported implementation authored that fallback."
    }
  }
];
