// @test-kind contract: HTTP fixture setup, local diagnostic stack policy, SDK compatibility and nonmutation checks; native scalar assertions are tagged individually below.
import { assertScalarParityBindings as __paqScalarBindings } from '../../scripts/qualify-parity.mjs';
__paqScalarBindings(import.meta.url, [
  {
    kind: 'scalar-reader-migration-v1',
    repositoryRoot: '../..',
    sourceAstSha256: '2a0beaeed72b5fd83548b6c4d62ce0fc3781424ebe336af7fb2368ecdd712def',
    producerPath: 'mirage/testing/webapi-contract.mjs',
    producerSha256: '8d30332b553e45f62de42e317e853d0753f98864c062ab688398415e9a378b3a',
    fixturePath: 'mirage/test/fixtures/webapi-native-scalar-reader.json',
    fixtureSha256: 'ca297cf7e3fd91a1ae9fd4a4b4e22eda260c517b384c7747bf71c295809e140b',
    helperSha256: 'dd91ee70daf856af97c265d6d19b59f8f3b55eb8e3692a430e419a93a3807bb7',
    proofs: [
      {
        path: 'mirage/test/fixtures/dataverse-batch23-scalar272-facts-v2.json',
        sha256: '7e3f4e05c34ce6c50bc7121af4252d17b444d8305b4763662f3261d97eb83250',
        mode: 'reproduced-native',
        capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
        facts: [
          {
            id: 'scalar-0-0',
            pointer: '/captures/0/cases/0/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/0/facts/status', '/captures/1/cases/0/facts/status'],
          },
          {
            id: 'scalar-0-1',
            pointer: '/captures/0/cases/0/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/0/facts/code', '/captures/1/cases/0/facts/code'],
          },
          {
            id: 'scalar-0-2',
            pointer: '/captures/0/cases/0/facts/cause',
            sha256: 'afea825604e3095f9534c5570f4e4c9cbe18fcc550095b6abdf52ba7543fef9d',
            replicatedPointers: ['/captures/0/cases/0/facts/cause', '/captures/1/cases/0/facts/cause'],
          },
          {
            id: 'scalar-0-3',
            pointer: '/captures/0/cases/0/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/0/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/0/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-1-0',
            pointer: '/captures/0/cases/1/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/1/facts/status', '/captures/1/cases/1/facts/status'],
          },
          {
            id: 'scalar-1-1',
            pointer: '/captures/0/cases/1/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/1/facts/code', '/captures/1/cases/1/facts/code'],
          },
          {
            id: 'scalar-1-2',
            pointer: '/captures/0/cases/1/facts/cause',
            sha256: 'afea825604e3095f9534c5570f4e4c9cbe18fcc550095b6abdf52ba7543fef9d',
            replicatedPointers: ['/captures/0/cases/1/facts/cause', '/captures/1/cases/1/facts/cause'],
          },
          {
            id: 'scalar-1-3',
            pointer: '/captures/0/cases/1/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/1/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/1/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-2-0',
            pointer: '/captures/0/cases/2/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/2/facts/status', '/captures/1/cases/2/facts/status'],
          },
          {
            id: 'scalar-2-1',
            pointer: '/captures/0/cases/2/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/2/facts/code', '/captures/1/cases/2/facts/code'],
          },
          {
            id: 'scalar-2-2',
            pointer: '/captures/0/cases/2/facts/cause',
            sha256: 'afea825604e3095f9534c5570f4e4c9cbe18fcc550095b6abdf52ba7543fef9d',
            replicatedPointers: ['/captures/0/cases/2/facts/cause', '/captures/1/cases/2/facts/cause'],
          },
          {
            id: 'scalar-2-3',
            pointer: '/captures/0/cases/2/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/2/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/2/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-3-0',
            pointer: '/captures/0/cases/3/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/3/facts/status', '/captures/1/cases/3/facts/status'],
          },
          {
            id: 'scalar-3-1',
            pointer: '/captures/0/cases/3/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/3/facts/code', '/captures/1/cases/3/facts/code'],
          },
          {
            id: 'scalar-3-2',
            pointer: '/captures/0/cases/3/facts/cause',
            sha256: 'afea825604e3095f9534c5570f4e4c9cbe18fcc550095b6abdf52ba7543fef9d',
            replicatedPointers: ['/captures/0/cases/3/facts/cause', '/captures/1/cases/3/facts/cause'],
          },
          {
            id: 'scalar-3-3',
            pointer: '/captures/0/cases/3/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/3/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/3/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-4-0',
            pointer: '/captures/0/cases/4/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/4/facts/status', '/captures/1/cases/4/facts/status'],
          },
          {
            id: 'scalar-4-1',
            pointer: '/captures/0/cases/4/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/4/facts/code', '/captures/1/cases/4/facts/code'],
          },
          {
            id: 'scalar-4-2',
            pointer: '/captures/0/cases/4/facts/cause',
            sha256: 'b55a94ea63b9d28f5762bedef0f1a7f2bef87d8a5749d76511b7395c338defbc',
            replicatedPointers: ['/captures/0/cases/4/facts/cause', '/captures/1/cases/4/facts/cause'],
          },
          {
            id: 'scalar-4-3',
            pointer: '/captures/0/cases/4/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/4/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/4/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-5-0',
            pointer: '/captures/0/cases/5/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/5/facts/status', '/captures/1/cases/5/facts/status'],
          },
          {
            id: 'scalar-5-1',
            pointer: '/captures/0/cases/5/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/5/facts/code', '/captures/1/cases/5/facts/code'],
          },
          {
            id: 'scalar-5-2',
            pointer: '/captures/0/cases/5/facts/cause',
            sha256: 'b55a94ea63b9d28f5762bedef0f1a7f2bef87d8a5749d76511b7395c338defbc',
            replicatedPointers: ['/captures/0/cases/5/facts/cause', '/captures/1/cases/5/facts/cause'],
          },
          {
            id: 'scalar-5-3',
            pointer: '/captures/0/cases/5/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/5/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/5/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-6-0',
            pointer: '/captures/0/cases/6/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/6/facts/status', '/captures/1/cases/6/facts/status'],
          },
          {
            id: 'scalar-6-1',
            pointer: '/captures/0/cases/6/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/6/facts/code', '/captures/1/cases/6/facts/code'],
          },
          {
            id: 'scalar-6-2',
            pointer: '/captures/0/cases/6/facts/cause',
            sha256: 'b55a94ea63b9d28f5762bedef0f1a7f2bef87d8a5749d76511b7395c338defbc',
            replicatedPointers: ['/captures/0/cases/6/facts/cause', '/captures/1/cases/6/facts/cause'],
          },
          {
            id: 'scalar-6-3',
            pointer: '/captures/0/cases/6/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/6/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/6/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-7-0',
            pointer: '/captures/0/cases/7/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/7/facts/status', '/captures/1/cases/7/facts/status'],
          },
          {
            id: 'scalar-7-1',
            pointer: '/captures/0/cases/7/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/7/facts/code', '/captures/1/cases/7/facts/code'],
          },
          {
            id: 'scalar-7-2',
            pointer: '/captures/0/cases/7/facts/cause',
            sha256: 'b55a94ea63b9d28f5762bedef0f1a7f2bef87d8a5749d76511b7395c338defbc',
            replicatedPointers: ['/captures/0/cases/7/facts/cause', '/captures/1/cases/7/facts/cause'],
          },
          {
            id: 'scalar-7-3',
            pointer: '/captures/0/cases/7/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/7/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/7/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-8-0',
            pointer: '/captures/0/cases/8/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/8/facts/status', '/captures/1/cases/8/facts/status'],
          },
          {
            id: 'scalar-8-1',
            pointer: '/captures/0/cases/8/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/8/facts/code', '/captures/1/cases/8/facts/code'],
          },
          {
            id: 'scalar-8-2',
            pointer: '/captures/0/cases/8/facts/cause',
            sha256: '5c0fe4f3f1dacd104790713119cf1837f62e97ef70c8dd7884272ba90a32f41e',
            replicatedPointers: ['/captures/0/cases/8/facts/cause', '/captures/1/cases/8/facts/cause'],
          },
          {
            id: 'scalar-8-3',
            pointer: '/captures/0/cases/8/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/8/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/8/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-9-0',
            pointer: '/captures/0/cases/9/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/9/facts/status', '/captures/1/cases/9/facts/status'],
          },
          {
            id: 'scalar-9-1',
            pointer: '/captures/0/cases/9/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/9/facts/code', '/captures/1/cases/9/facts/code'],
          },
          {
            id: 'scalar-9-2',
            pointer: '/captures/0/cases/9/facts/cause',
            sha256: '5c0fe4f3f1dacd104790713119cf1837f62e97ef70c8dd7884272ba90a32f41e',
            replicatedPointers: ['/captures/0/cases/9/facts/cause', '/captures/1/cases/9/facts/cause'],
          },
          {
            id: 'scalar-9-3',
            pointer: '/captures/0/cases/9/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/9/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/9/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-10-0',
            pointer: '/captures/0/cases/10/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/10/facts/status', '/captures/1/cases/10/facts/status'],
          },
          {
            id: 'scalar-10-1',
            pointer: '/captures/0/cases/10/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/10/facts/code', '/captures/1/cases/10/facts/code'],
          },
          {
            id: 'scalar-10-2',
            pointer: '/captures/0/cases/10/facts/cause',
            sha256: '5c0fe4f3f1dacd104790713119cf1837f62e97ef70c8dd7884272ba90a32f41e',
            replicatedPointers: ['/captures/0/cases/10/facts/cause', '/captures/1/cases/10/facts/cause'],
          },
          {
            id: 'scalar-10-3',
            pointer: '/captures/0/cases/10/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/10/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/10/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-11-0',
            pointer: '/captures/0/cases/11/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/11/facts/status', '/captures/1/cases/11/facts/status'],
          },
          {
            id: 'scalar-11-1',
            pointer: '/captures/0/cases/11/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/11/facts/code', '/captures/1/cases/11/facts/code'],
          },
          {
            id: 'scalar-11-2',
            pointer: '/captures/0/cases/11/facts/cause',
            sha256: '5c0fe4f3f1dacd104790713119cf1837f62e97ef70c8dd7884272ba90a32f41e',
            replicatedPointers: ['/captures/0/cases/11/facts/cause', '/captures/1/cases/11/facts/cause'],
          },
          {
            id: 'scalar-11-3',
            pointer: '/captures/0/cases/11/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/11/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/11/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-12-0',
            pointer: '/captures/0/cases/12/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/12/facts/status', '/captures/1/cases/12/facts/status'],
          },
          {
            id: 'scalar-12-1',
            pointer: '/captures/0/cases/12/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/12/facts/code', '/captures/1/cases/12/facts/code'],
          },
          {
            id: 'scalar-12-2',
            pointer: '/captures/0/cases/12/facts/cause',
            sha256: '0466b5ff6d9583cc44c9699a89af3c928f86ad85fc9fbb19859fafbec5fdce3d',
            replicatedPointers: ['/captures/0/cases/12/facts/cause', '/captures/1/cases/12/facts/cause'],
          },
          {
            id: 'scalar-12-3',
            pointer: '/captures/0/cases/12/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/12/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/12/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-13-0',
            pointer: '/captures/0/cases/13/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/13/facts/status', '/captures/1/cases/13/facts/status'],
          },
          {
            id: 'scalar-13-1',
            pointer: '/captures/0/cases/13/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/13/facts/code', '/captures/1/cases/13/facts/code'],
          },
          {
            id: 'scalar-13-2',
            pointer: '/captures/0/cases/13/facts/cause',
            sha256: '0466b5ff6d9583cc44c9699a89af3c928f86ad85fc9fbb19859fafbec5fdce3d',
            replicatedPointers: ['/captures/0/cases/13/facts/cause', '/captures/1/cases/13/facts/cause'],
          },
          {
            id: 'scalar-13-3',
            pointer: '/captures/0/cases/13/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/13/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/13/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-14-0',
            pointer: '/captures/0/cases/14/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/14/facts/status', '/captures/1/cases/14/facts/status'],
          },
          {
            id: 'scalar-14-1',
            pointer: '/captures/0/cases/14/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/14/facts/code', '/captures/1/cases/14/facts/code'],
          },
          {
            id: 'scalar-14-2',
            pointer: '/captures/0/cases/14/facts/cause',
            sha256: '0466b5ff6d9583cc44c9699a89af3c928f86ad85fc9fbb19859fafbec5fdce3d',
            replicatedPointers: ['/captures/0/cases/14/facts/cause', '/captures/1/cases/14/facts/cause'],
          },
          {
            id: 'scalar-14-3',
            pointer: '/captures/0/cases/14/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/14/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/14/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-15-0',
            pointer: '/captures/0/cases/15/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/15/facts/status', '/captures/1/cases/15/facts/status'],
          },
          {
            id: 'scalar-15-1',
            pointer: '/captures/0/cases/15/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/15/facts/code', '/captures/1/cases/15/facts/code'],
          },
          {
            id: 'scalar-15-2',
            pointer: '/captures/0/cases/15/facts/cause',
            sha256: '0466b5ff6d9583cc44c9699a89af3c928f86ad85fc9fbb19859fafbec5fdce3d',
            replicatedPointers: ['/captures/0/cases/15/facts/cause', '/captures/1/cases/15/facts/cause'],
          },
          {
            id: 'scalar-15-3',
            pointer: '/captures/0/cases/15/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/15/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/15/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-16-0',
            pointer: '/captures/0/cases/16/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/16/facts/status', '/captures/1/cases/16/facts/status'],
          },
          {
            id: 'scalar-16-1',
            pointer: '/captures/0/cases/16/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/16/facts/code', '/captures/1/cases/16/facts/code'],
          },
          {
            id: 'scalar-16-2',
            pointer: '/captures/0/cases/16/facts/cause',
            sha256: '4865a3aaf96054fcc42d01e57dab0e459db963d9fb934b8b3ea57244464b27f4',
            replicatedPointers: ['/captures/0/cases/16/facts/cause', '/captures/1/cases/16/facts/cause'],
          },
          {
            id: 'scalar-16-3',
            pointer: '/captures/0/cases/16/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/16/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/16/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-17-0',
            pointer: '/captures/0/cases/17/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/17/facts/status', '/captures/1/cases/17/facts/status'],
          },
          {
            id: 'scalar-17-1',
            pointer: '/captures/0/cases/17/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/17/facts/code', '/captures/1/cases/17/facts/code'],
          },
          {
            id: 'scalar-17-2',
            pointer: '/captures/0/cases/17/facts/cause',
            sha256: '4865a3aaf96054fcc42d01e57dab0e459db963d9fb934b8b3ea57244464b27f4',
            replicatedPointers: ['/captures/0/cases/17/facts/cause', '/captures/1/cases/17/facts/cause'],
          },
          {
            id: 'scalar-17-3',
            pointer: '/captures/0/cases/17/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/17/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/17/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-18-0',
            pointer: '/captures/0/cases/18/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/18/facts/status', '/captures/1/cases/18/facts/status'],
          },
          {
            id: 'scalar-18-1',
            pointer: '/captures/0/cases/18/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/18/facts/code', '/captures/1/cases/18/facts/code'],
          },
          {
            id: 'scalar-18-2',
            pointer: '/captures/0/cases/18/facts/cause',
            sha256: '4865a3aaf96054fcc42d01e57dab0e459db963d9fb934b8b3ea57244464b27f4',
            replicatedPointers: ['/captures/0/cases/18/facts/cause', '/captures/1/cases/18/facts/cause'],
          },
          {
            id: 'scalar-18-3',
            pointer: '/captures/0/cases/18/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/18/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/18/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-19-0',
            pointer: '/captures/0/cases/19/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/19/facts/status', '/captures/1/cases/19/facts/status'],
          },
          {
            id: 'scalar-19-1',
            pointer: '/captures/0/cases/19/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/19/facts/code', '/captures/1/cases/19/facts/code'],
          },
          {
            id: 'scalar-19-2',
            pointer: '/captures/0/cases/19/facts/cause',
            sha256: '4865a3aaf96054fcc42d01e57dab0e459db963d9fb934b8b3ea57244464b27f4',
            replicatedPointers: ['/captures/0/cases/19/facts/cause', '/captures/1/cases/19/facts/cause'],
          },
          {
            id: 'scalar-19-3',
            pointer: '/captures/0/cases/19/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/19/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/19/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-20-0',
            pointer: '/captures/0/cases/20/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/20/facts/status', '/captures/1/cases/20/facts/status'],
          },
          {
            id: 'scalar-20-1',
            pointer: '/captures/0/cases/20/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/20/facts/code', '/captures/1/cases/20/facts/code'],
          },
          {
            id: 'scalar-20-2',
            pointer: '/captures/0/cases/20/facts/cause',
            sha256: 'b93507a4396ad345f937494e9c4ff8c880a27adf90049046cd93bacb4f5ec345',
            replicatedPointers: ['/captures/0/cases/20/facts/cause', '/captures/1/cases/20/facts/cause'],
          },
          {
            id: 'scalar-20-3',
            pointer: '/captures/0/cases/20/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/20/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/20/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-21-0',
            pointer: '/captures/0/cases/21/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/21/facts/status', '/captures/1/cases/21/facts/status'],
          },
          {
            id: 'scalar-21-1',
            pointer: '/captures/0/cases/21/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/21/facts/code', '/captures/1/cases/21/facts/code'],
          },
          {
            id: 'scalar-21-2',
            pointer: '/captures/0/cases/21/facts/cause',
            sha256: 'b93507a4396ad345f937494e9c4ff8c880a27adf90049046cd93bacb4f5ec345',
            replicatedPointers: ['/captures/0/cases/21/facts/cause', '/captures/1/cases/21/facts/cause'],
          },
          {
            id: 'scalar-21-3',
            pointer: '/captures/0/cases/21/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/21/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/21/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-22-0',
            pointer: '/captures/0/cases/22/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/22/facts/status', '/captures/1/cases/22/facts/status'],
          },
          {
            id: 'scalar-22-1',
            pointer: '/captures/0/cases/22/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/22/facts/code', '/captures/1/cases/22/facts/code'],
          },
          {
            id: 'scalar-22-2',
            pointer: '/captures/0/cases/22/facts/cause',
            sha256: 'b93507a4396ad345f937494e9c4ff8c880a27adf90049046cd93bacb4f5ec345',
            replicatedPointers: ['/captures/0/cases/22/facts/cause', '/captures/1/cases/22/facts/cause'],
          },
          {
            id: 'scalar-22-3',
            pointer: '/captures/0/cases/22/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/22/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/22/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-23-0',
            pointer: '/captures/0/cases/23/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/23/facts/status', '/captures/1/cases/23/facts/status'],
          },
          {
            id: 'scalar-23-1',
            pointer: '/captures/0/cases/23/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/23/facts/code', '/captures/1/cases/23/facts/code'],
          },
          {
            id: 'scalar-23-2',
            pointer: '/captures/0/cases/23/facts/cause',
            sha256: 'b93507a4396ad345f937494e9c4ff8c880a27adf90049046cd93bacb4f5ec345',
            replicatedPointers: ['/captures/0/cases/23/facts/cause', '/captures/1/cases/23/facts/cause'],
          },
          {
            id: 'scalar-23-3',
            pointer: '/captures/0/cases/23/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/23/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/23/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-24-0',
            pointer: '/captures/0/cases/24/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/24/facts/status', '/captures/1/cases/24/facts/status'],
          },
          {
            id: 'scalar-24-1',
            pointer: '/captures/0/cases/24/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/24/facts/code', '/captures/1/cases/24/facts/code'],
          },
          {
            id: 'scalar-24-2',
            pointer: '/captures/0/cases/24/facts/cause',
            sha256: '563ac0e5bebca996ea96f72cb44b46f443c644daa8e3ab77028a7b8befe601c0',
            replicatedPointers: ['/captures/0/cases/24/facts/cause', '/captures/1/cases/24/facts/cause'],
          },
          {
            id: 'scalar-24-3',
            pointer: '/captures/0/cases/24/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/24/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/24/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-25-0',
            pointer: '/captures/0/cases/25/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/25/facts/status', '/captures/1/cases/25/facts/status'],
          },
          {
            id: 'scalar-25-1',
            pointer: '/captures/0/cases/25/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/25/facts/code', '/captures/1/cases/25/facts/code'],
          },
          {
            id: 'scalar-25-2',
            pointer: '/captures/0/cases/25/facts/cause',
            sha256: '563ac0e5bebca996ea96f72cb44b46f443c644daa8e3ab77028a7b8befe601c0',
            replicatedPointers: ['/captures/0/cases/25/facts/cause', '/captures/1/cases/25/facts/cause'],
          },
          {
            id: 'scalar-25-3',
            pointer: '/captures/0/cases/25/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/25/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/25/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-26-0',
            pointer: '/captures/0/cases/26/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/26/facts/status', '/captures/1/cases/26/facts/status'],
          },
          {
            id: 'scalar-26-1',
            pointer: '/captures/0/cases/26/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/26/facts/code', '/captures/1/cases/26/facts/code'],
          },
          {
            id: 'scalar-26-2',
            pointer: '/captures/0/cases/26/facts/cause',
            sha256: '563ac0e5bebca996ea96f72cb44b46f443c644daa8e3ab77028a7b8befe601c0',
            replicatedPointers: ['/captures/0/cases/26/facts/cause', '/captures/1/cases/26/facts/cause'],
          },
          {
            id: 'scalar-26-3',
            pointer: '/captures/0/cases/26/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/26/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/26/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-27-0',
            pointer: '/captures/0/cases/27/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/27/facts/status', '/captures/1/cases/27/facts/status'],
          },
          {
            id: 'scalar-27-1',
            pointer: '/captures/0/cases/27/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/27/facts/code', '/captures/1/cases/27/facts/code'],
          },
          {
            id: 'scalar-27-2',
            pointer: '/captures/0/cases/27/facts/cause',
            sha256: '563ac0e5bebca996ea96f72cb44b46f443c644daa8e3ab77028a7b8befe601c0',
            replicatedPointers: ['/captures/0/cases/27/facts/cause', '/captures/1/cases/27/facts/cause'],
          },
          {
            id: 'scalar-27-3',
            pointer: '/captures/0/cases/27/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/27/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/27/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-28-0',
            pointer: '/captures/0/cases/28/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/28/facts/status', '/captures/1/cases/28/facts/status'],
          },
          {
            id: 'scalar-28-1',
            pointer: '/captures/0/cases/28/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/28/facts/code', '/captures/1/cases/28/facts/code'],
          },
          {
            id: 'scalar-28-2',
            pointer: '/captures/0/cases/28/facts/cause',
            sha256: '46385f29484821a9f61cc4c086cb0e5b673bf337065843e9651f13d44b860812',
            replicatedPointers: ['/captures/0/cases/28/facts/cause', '/captures/1/cases/28/facts/cause'],
          },
          {
            id: 'scalar-28-3',
            pointer: '/captures/0/cases/28/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/28/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/28/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-29-0',
            pointer: '/captures/0/cases/29/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/29/facts/status', '/captures/1/cases/29/facts/status'],
          },
          {
            id: 'scalar-29-1',
            pointer: '/captures/0/cases/29/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/29/facts/code', '/captures/1/cases/29/facts/code'],
          },
          {
            id: 'scalar-29-2',
            pointer: '/captures/0/cases/29/facts/cause',
            sha256: '46385f29484821a9f61cc4c086cb0e5b673bf337065843e9651f13d44b860812',
            replicatedPointers: ['/captures/0/cases/29/facts/cause', '/captures/1/cases/29/facts/cause'],
          },
          {
            id: 'scalar-29-3',
            pointer: '/captures/0/cases/29/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/29/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/29/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-30-0',
            pointer: '/captures/0/cases/30/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/30/facts/status', '/captures/1/cases/30/facts/status'],
          },
          {
            id: 'scalar-30-1',
            pointer: '/captures/0/cases/30/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/30/facts/code', '/captures/1/cases/30/facts/code'],
          },
          {
            id: 'scalar-30-2',
            pointer: '/captures/0/cases/30/facts/cause',
            sha256: '46385f29484821a9f61cc4c086cb0e5b673bf337065843e9651f13d44b860812',
            replicatedPointers: ['/captures/0/cases/30/facts/cause', '/captures/1/cases/30/facts/cause'],
          },
          {
            id: 'scalar-30-3',
            pointer: '/captures/0/cases/30/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/30/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/30/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-31-0',
            pointer: '/captures/0/cases/31/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/31/facts/status', '/captures/1/cases/31/facts/status'],
          },
          {
            id: 'scalar-31-1',
            pointer: '/captures/0/cases/31/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/31/facts/code', '/captures/1/cases/31/facts/code'],
          },
          {
            id: 'scalar-31-2',
            pointer: '/captures/0/cases/31/facts/cause',
            sha256: '46385f29484821a9f61cc4c086cb0e5b673bf337065843e9651f13d44b860812',
            replicatedPointers: ['/captures/0/cases/31/facts/cause', '/captures/1/cases/31/facts/cause'],
          },
          {
            id: 'scalar-31-3',
            pointer: '/captures/0/cases/31/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/31/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/31/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-32-0',
            pointer: '/captures/0/cases/32/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/32/facts/status', '/captures/1/cases/32/facts/status'],
          },
          {
            id: 'scalar-32-1',
            pointer: '/captures/0/cases/32/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/32/facts/code', '/captures/1/cases/32/facts/code'],
          },
          {
            id: 'scalar-32-2',
            pointer: '/captures/0/cases/32/facts/cause',
            sha256: 'a6ea946f42a559a47acb20f887e1814ee797e36722f7e9e43580de6c247ed274',
            replicatedPointers: ['/captures/0/cases/32/facts/cause', '/captures/1/cases/32/facts/cause'],
          },
          {
            id: 'scalar-32-3',
            pointer: '/captures/0/cases/32/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/32/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/32/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-33-0',
            pointer: '/captures/0/cases/33/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/33/facts/status', '/captures/1/cases/33/facts/status'],
          },
          {
            id: 'scalar-33-1',
            pointer: '/captures/0/cases/33/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/33/facts/code', '/captures/1/cases/33/facts/code'],
          },
          {
            id: 'scalar-33-2',
            pointer: '/captures/0/cases/33/facts/cause',
            sha256: 'a6ea946f42a559a47acb20f887e1814ee797e36722f7e9e43580de6c247ed274',
            replicatedPointers: ['/captures/0/cases/33/facts/cause', '/captures/1/cases/33/facts/cause'],
          },
          {
            id: 'scalar-33-3',
            pointer: '/captures/0/cases/33/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/33/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/33/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-34-0',
            pointer: '/captures/0/cases/34/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/34/facts/status', '/captures/1/cases/34/facts/status'],
          },
          {
            id: 'scalar-34-1',
            pointer: '/captures/0/cases/34/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/34/facts/code', '/captures/1/cases/34/facts/code'],
          },
          {
            id: 'scalar-34-2',
            pointer: '/captures/0/cases/34/facts/cause',
            sha256: 'a6ea946f42a559a47acb20f887e1814ee797e36722f7e9e43580de6c247ed274',
            replicatedPointers: ['/captures/0/cases/34/facts/cause', '/captures/1/cases/34/facts/cause'],
          },
          {
            id: 'scalar-34-3',
            pointer: '/captures/0/cases/34/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/34/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/34/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-35-0',
            pointer: '/captures/0/cases/35/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/35/facts/status', '/captures/1/cases/35/facts/status'],
          },
          {
            id: 'scalar-35-1',
            pointer: '/captures/0/cases/35/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/35/facts/code', '/captures/1/cases/35/facts/code'],
          },
          {
            id: 'scalar-35-2',
            pointer: '/captures/0/cases/35/facts/cause',
            sha256: 'a6ea946f42a559a47acb20f887e1814ee797e36722f7e9e43580de6c247ed274',
            replicatedPointers: ['/captures/0/cases/35/facts/cause', '/captures/1/cases/35/facts/cause'],
          },
          {
            id: 'scalar-35-3',
            pointer: '/captures/0/cases/35/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/35/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/35/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-36-0',
            pointer: '/captures/0/cases/36/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/36/facts/status', '/captures/1/cases/36/facts/status'],
          },
          {
            id: 'scalar-36-1',
            pointer: '/captures/0/cases/36/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/36/facts/code', '/captures/1/cases/36/facts/code'],
          },
          {
            id: 'scalar-36-2',
            pointer: '/captures/0/cases/36/facts/cause',
            sha256: '7cf7c207fe1c61a72499a908eb8c526518bcf3f8a0981931e4b7b474207c8357',
            replicatedPointers: ['/captures/0/cases/36/facts/cause', '/captures/1/cases/36/facts/cause'],
          },
          {
            id: 'scalar-36-3',
            pointer: '/captures/0/cases/36/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/36/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/36/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-37-0',
            pointer: '/captures/0/cases/37/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/37/facts/status', '/captures/1/cases/37/facts/status'],
          },
          {
            id: 'scalar-37-1',
            pointer: '/captures/0/cases/37/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/37/facts/code', '/captures/1/cases/37/facts/code'],
          },
          {
            id: 'scalar-37-2',
            pointer: '/captures/0/cases/37/facts/cause',
            sha256: '7cf7c207fe1c61a72499a908eb8c526518bcf3f8a0981931e4b7b474207c8357',
            replicatedPointers: ['/captures/0/cases/37/facts/cause', '/captures/1/cases/37/facts/cause'],
          },
          {
            id: 'scalar-37-3',
            pointer: '/captures/0/cases/37/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/37/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/37/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-38-0',
            pointer: '/captures/0/cases/38/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/38/facts/status', '/captures/1/cases/38/facts/status'],
          },
          {
            id: 'scalar-38-1',
            pointer: '/captures/0/cases/38/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/38/facts/code', '/captures/1/cases/38/facts/code'],
          },
          {
            id: 'scalar-38-2',
            pointer: '/captures/0/cases/38/facts/cause',
            sha256: '7cf7c207fe1c61a72499a908eb8c526518bcf3f8a0981931e4b7b474207c8357',
            replicatedPointers: ['/captures/0/cases/38/facts/cause', '/captures/1/cases/38/facts/cause'],
          },
          {
            id: 'scalar-38-3',
            pointer: '/captures/0/cases/38/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/38/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/38/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-39-0',
            pointer: '/captures/0/cases/39/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/39/facts/status', '/captures/1/cases/39/facts/status'],
          },
          {
            id: 'scalar-39-1',
            pointer: '/captures/0/cases/39/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/39/facts/code', '/captures/1/cases/39/facts/code'],
          },
          {
            id: 'scalar-39-2',
            pointer: '/captures/0/cases/39/facts/cause',
            sha256: '7cf7c207fe1c61a72499a908eb8c526518bcf3f8a0981931e4b7b474207c8357',
            replicatedPointers: ['/captures/0/cases/39/facts/cause', '/captures/1/cases/39/facts/cause'],
          },
          {
            id: 'scalar-39-3',
            pointer: '/captures/0/cases/39/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/39/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/39/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-40-0',
            pointer: '/captures/0/cases/40/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/40/facts/status', '/captures/1/cases/40/facts/status'],
          },
          {
            id: 'scalar-40-1',
            pointer: '/captures/0/cases/40/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/40/facts/code', '/captures/1/cases/40/facts/code'],
          },
          {
            id: 'scalar-40-2',
            pointer: '/captures/0/cases/40/facts/cause',
            sha256: '07063c32695e34548976e74e0824b05e49f695413ee5eec523c39db9bce11380',
            replicatedPointers: ['/captures/0/cases/40/facts/cause', '/captures/1/cases/40/facts/cause'],
          },
          {
            id: 'scalar-40-3',
            pointer: '/captures/0/cases/40/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/40/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/40/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-41-0',
            pointer: '/captures/0/cases/41/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/41/facts/status', '/captures/1/cases/41/facts/status'],
          },
          {
            id: 'scalar-41-1',
            pointer: '/captures/0/cases/41/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/41/facts/code', '/captures/1/cases/41/facts/code'],
          },
          {
            id: 'scalar-41-2',
            pointer: '/captures/0/cases/41/facts/cause',
            sha256: '07063c32695e34548976e74e0824b05e49f695413ee5eec523c39db9bce11380',
            replicatedPointers: ['/captures/0/cases/41/facts/cause', '/captures/1/cases/41/facts/cause'],
          },
          {
            id: 'scalar-41-3',
            pointer: '/captures/0/cases/41/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/41/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/41/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-42-0',
            pointer: '/captures/0/cases/42/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/42/facts/status', '/captures/1/cases/42/facts/status'],
          },
          {
            id: 'scalar-42-1',
            pointer: '/captures/0/cases/42/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/42/facts/code', '/captures/1/cases/42/facts/code'],
          },
          {
            id: 'scalar-42-2',
            pointer: '/captures/0/cases/42/facts/cause',
            sha256: '07063c32695e34548976e74e0824b05e49f695413ee5eec523c39db9bce11380',
            replicatedPointers: ['/captures/0/cases/42/facts/cause', '/captures/1/cases/42/facts/cause'],
          },
          {
            id: 'scalar-42-3',
            pointer: '/captures/0/cases/42/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/42/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/42/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-43-0',
            pointer: '/captures/0/cases/43/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/43/facts/status', '/captures/1/cases/43/facts/status'],
          },
          {
            id: 'scalar-43-1',
            pointer: '/captures/0/cases/43/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/43/facts/code', '/captures/1/cases/43/facts/code'],
          },
          {
            id: 'scalar-43-2',
            pointer: '/captures/0/cases/43/facts/cause',
            sha256: '07063c32695e34548976e74e0824b05e49f695413ee5eec523c39db9bce11380',
            replicatedPointers: ['/captures/0/cases/43/facts/cause', '/captures/1/cases/43/facts/cause'],
          },
          {
            id: 'scalar-43-3',
            pointer: '/captures/0/cases/43/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/43/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/43/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-44-0',
            pointer: '/captures/0/cases/44/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/44/facts/status', '/captures/1/cases/44/facts/status'],
          },
          {
            id: 'scalar-44-1',
            pointer: '/captures/0/cases/44/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/44/facts/code', '/captures/1/cases/44/facts/code'],
          },
          {
            id: 'scalar-44-2',
            pointer: '/captures/0/cases/44/facts/cause',
            sha256: 'd5d8596325419c94a2fedcc6653ad902da5655c135c17d04ab6bbf29a08211cc',
            replicatedPointers: ['/captures/0/cases/44/facts/cause', '/captures/1/cases/44/facts/cause'],
          },
          {
            id: 'scalar-44-3',
            pointer: '/captures/0/cases/44/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/44/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/44/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-45-0',
            pointer: '/captures/0/cases/45/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/45/facts/status', '/captures/1/cases/45/facts/status'],
          },
          {
            id: 'scalar-45-1',
            pointer: '/captures/0/cases/45/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/45/facts/code', '/captures/1/cases/45/facts/code'],
          },
          {
            id: 'scalar-45-2',
            pointer: '/captures/0/cases/45/facts/cause',
            sha256: 'd5d8596325419c94a2fedcc6653ad902da5655c135c17d04ab6bbf29a08211cc',
            replicatedPointers: ['/captures/0/cases/45/facts/cause', '/captures/1/cases/45/facts/cause'],
          },
          {
            id: 'scalar-45-3',
            pointer: '/captures/0/cases/45/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/45/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/45/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-46-0',
            pointer: '/captures/0/cases/46/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/46/facts/status', '/captures/1/cases/46/facts/status'],
          },
          {
            id: 'scalar-46-1',
            pointer: '/captures/0/cases/46/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/46/facts/code', '/captures/1/cases/46/facts/code'],
          },
          {
            id: 'scalar-46-2',
            pointer: '/captures/0/cases/46/facts/cause',
            sha256: 'd5d8596325419c94a2fedcc6653ad902da5655c135c17d04ab6bbf29a08211cc',
            replicatedPointers: ['/captures/0/cases/46/facts/cause', '/captures/1/cases/46/facts/cause'],
          },
          {
            id: 'scalar-46-3',
            pointer: '/captures/0/cases/46/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/46/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/46/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-47-0',
            pointer: '/captures/0/cases/47/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/47/facts/status', '/captures/1/cases/47/facts/status'],
          },
          {
            id: 'scalar-47-1',
            pointer: '/captures/0/cases/47/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/47/facts/code', '/captures/1/cases/47/facts/code'],
          },
          {
            id: 'scalar-47-2',
            pointer: '/captures/0/cases/47/facts/cause',
            sha256: 'd5d8596325419c94a2fedcc6653ad902da5655c135c17d04ab6bbf29a08211cc',
            replicatedPointers: ['/captures/0/cases/47/facts/cause', '/captures/1/cases/47/facts/cause'],
          },
          {
            id: 'scalar-47-3',
            pointer: '/captures/0/cases/47/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/47/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/47/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-48-0',
            pointer: '/captures/0/cases/48/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/48/facts/status', '/captures/1/cases/48/facts/status'],
          },
          {
            id: 'scalar-48-1',
            pointer: '/captures/0/cases/48/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/48/facts/code', '/captures/1/cases/48/facts/code'],
          },
          {
            id: 'scalar-48-2',
            pointer: '/captures/0/cases/48/facts/cause',
            sha256: '7ace1200a365743938783a425209ab325e121888945ef50e033f095732210649',
            replicatedPointers: ['/captures/0/cases/48/facts/cause', '/captures/1/cases/48/facts/cause'],
          },
          {
            id: 'scalar-48-3',
            pointer: '/captures/0/cases/48/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/48/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/48/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-49-0',
            pointer: '/captures/0/cases/49/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/49/facts/status', '/captures/1/cases/49/facts/status'],
          },
          {
            id: 'scalar-49-1',
            pointer: '/captures/0/cases/49/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/49/facts/code', '/captures/1/cases/49/facts/code'],
          },
          {
            id: 'scalar-49-2',
            pointer: '/captures/0/cases/49/facts/cause',
            sha256: '7ace1200a365743938783a425209ab325e121888945ef50e033f095732210649',
            replicatedPointers: ['/captures/0/cases/49/facts/cause', '/captures/1/cases/49/facts/cause'],
          },
          {
            id: 'scalar-49-3',
            pointer: '/captures/0/cases/49/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/49/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/49/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-50-0',
            pointer: '/captures/0/cases/50/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/50/facts/status', '/captures/1/cases/50/facts/status'],
          },
          {
            id: 'scalar-50-1',
            pointer: '/captures/0/cases/50/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/50/facts/code', '/captures/1/cases/50/facts/code'],
          },
          {
            id: 'scalar-50-2',
            pointer: '/captures/0/cases/50/facts/cause',
            sha256: '7ace1200a365743938783a425209ab325e121888945ef50e033f095732210649',
            replicatedPointers: ['/captures/0/cases/50/facts/cause', '/captures/1/cases/50/facts/cause'],
          },
          {
            id: 'scalar-50-3',
            pointer: '/captures/0/cases/50/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/50/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/50/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-51-0',
            pointer: '/captures/0/cases/51/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/51/facts/status', '/captures/1/cases/51/facts/status'],
          },
          {
            id: 'scalar-51-1',
            pointer: '/captures/0/cases/51/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/51/facts/code', '/captures/1/cases/51/facts/code'],
          },
          {
            id: 'scalar-51-2',
            pointer: '/captures/0/cases/51/facts/cause',
            sha256: '7ace1200a365743938783a425209ab325e121888945ef50e033f095732210649',
            replicatedPointers: ['/captures/0/cases/51/facts/cause', '/captures/1/cases/51/facts/cause'],
          },
          {
            id: 'scalar-51-3',
            pointer: '/captures/0/cases/51/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/51/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/51/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-52-0',
            pointer: '/captures/0/cases/52/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/52/facts/status', '/captures/1/cases/52/facts/status'],
          },
          {
            id: 'scalar-52-1',
            pointer: '/captures/0/cases/52/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/52/facts/code', '/captures/1/cases/52/facts/code'],
          },
          {
            id: 'scalar-52-2',
            pointer: '/captures/0/cases/52/facts/cause',
            sha256: 'a88bb2d5394889eabc86294203440952e9e9fa7667506f5ba5c74d0b3e4822fe',
            replicatedPointers: ['/captures/0/cases/52/facts/cause', '/captures/1/cases/52/facts/cause'],
          },
          {
            id: 'scalar-52-3',
            pointer: '/captures/0/cases/52/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/52/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/52/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-53-0',
            pointer: '/captures/0/cases/53/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/53/facts/status', '/captures/1/cases/53/facts/status'],
          },
          {
            id: 'scalar-53-1',
            pointer: '/captures/0/cases/53/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/53/facts/code', '/captures/1/cases/53/facts/code'],
          },
          {
            id: 'scalar-53-2',
            pointer: '/captures/0/cases/53/facts/cause',
            sha256: 'a88bb2d5394889eabc86294203440952e9e9fa7667506f5ba5c74d0b3e4822fe',
            replicatedPointers: ['/captures/0/cases/53/facts/cause', '/captures/1/cases/53/facts/cause'],
          },
          {
            id: 'scalar-53-3',
            pointer: '/captures/0/cases/53/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/53/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/53/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-54-0',
            pointer: '/captures/0/cases/54/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/54/facts/status', '/captures/1/cases/54/facts/status'],
          },
          {
            id: 'scalar-54-1',
            pointer: '/captures/0/cases/54/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/54/facts/code', '/captures/1/cases/54/facts/code'],
          },
          {
            id: 'scalar-54-2',
            pointer: '/captures/0/cases/54/facts/cause',
            sha256: 'a88bb2d5394889eabc86294203440952e9e9fa7667506f5ba5c74d0b3e4822fe',
            replicatedPointers: ['/captures/0/cases/54/facts/cause', '/captures/1/cases/54/facts/cause'],
          },
          {
            id: 'scalar-54-3',
            pointer: '/captures/0/cases/54/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/54/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/54/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-55-0',
            pointer: '/captures/0/cases/55/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/55/facts/status', '/captures/1/cases/55/facts/status'],
          },
          {
            id: 'scalar-55-1',
            pointer: '/captures/0/cases/55/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/55/facts/code', '/captures/1/cases/55/facts/code'],
          },
          {
            id: 'scalar-55-2',
            pointer: '/captures/0/cases/55/facts/cause',
            sha256: 'a88bb2d5394889eabc86294203440952e9e9fa7667506f5ba5c74d0b3e4822fe',
            replicatedPointers: ['/captures/0/cases/55/facts/cause', '/captures/1/cases/55/facts/cause'],
          },
          {
            id: 'scalar-55-3',
            pointer: '/captures/0/cases/55/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/55/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/55/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-56-0',
            pointer: '/captures/0/cases/56/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/56/facts/status', '/captures/1/cases/56/facts/status'],
          },
          {
            id: 'scalar-56-1',
            pointer: '/captures/0/cases/56/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/56/facts/code', '/captures/1/cases/56/facts/code'],
          },
          {
            id: 'scalar-56-2',
            pointer: '/captures/0/cases/56/facts/cause',
            sha256: '7bd22a0d3677b96ef2052ab62608aa73ffd00e487d855f951ce5ebd8be66ac1a',
            replicatedPointers: ['/captures/0/cases/56/facts/cause', '/captures/1/cases/56/facts/cause'],
          },
          {
            id: 'scalar-56-3',
            pointer: '/captures/0/cases/56/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/56/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/56/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-57-0',
            pointer: '/captures/0/cases/57/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/57/facts/status', '/captures/1/cases/57/facts/status'],
          },
          {
            id: 'scalar-57-1',
            pointer: '/captures/0/cases/57/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/57/facts/code', '/captures/1/cases/57/facts/code'],
          },
          {
            id: 'scalar-57-2',
            pointer: '/captures/0/cases/57/facts/cause',
            sha256: '7bd22a0d3677b96ef2052ab62608aa73ffd00e487d855f951ce5ebd8be66ac1a',
            replicatedPointers: ['/captures/0/cases/57/facts/cause', '/captures/1/cases/57/facts/cause'],
          },
          {
            id: 'scalar-57-3',
            pointer: '/captures/0/cases/57/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/57/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/57/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-58-0',
            pointer: '/captures/0/cases/58/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/58/facts/status', '/captures/1/cases/58/facts/status'],
          },
          {
            id: 'scalar-58-1',
            pointer: '/captures/0/cases/58/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/58/facts/code', '/captures/1/cases/58/facts/code'],
          },
          {
            id: 'scalar-58-2',
            pointer: '/captures/0/cases/58/facts/cause',
            sha256: '7bd22a0d3677b96ef2052ab62608aa73ffd00e487d855f951ce5ebd8be66ac1a',
            replicatedPointers: ['/captures/0/cases/58/facts/cause', '/captures/1/cases/58/facts/cause'],
          },
          {
            id: 'scalar-58-3',
            pointer: '/captures/0/cases/58/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/58/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/58/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-59-0',
            pointer: '/captures/0/cases/59/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/59/facts/status', '/captures/1/cases/59/facts/status'],
          },
          {
            id: 'scalar-59-1',
            pointer: '/captures/0/cases/59/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/59/facts/code', '/captures/1/cases/59/facts/code'],
          },
          {
            id: 'scalar-59-2',
            pointer: '/captures/0/cases/59/facts/cause',
            sha256: '7bd22a0d3677b96ef2052ab62608aa73ffd00e487d855f951ce5ebd8be66ac1a',
            replicatedPointers: ['/captures/0/cases/59/facts/cause', '/captures/1/cases/59/facts/cause'],
          },
          {
            id: 'scalar-59-3',
            pointer: '/captures/0/cases/59/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/59/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/59/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-60-0',
            pointer: '/captures/0/cases/60/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/60/facts/status', '/captures/1/cases/60/facts/status'],
          },
          {
            id: 'scalar-60-1',
            pointer: '/captures/0/cases/60/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/60/facts/code', '/captures/1/cases/60/facts/code'],
          },
          {
            id: 'scalar-60-2',
            pointer: '/captures/0/cases/60/facts/cause',
            sha256: '90fd385f4ad7f4f8d77b5948c02b2d418b9bfb1c67d0e48802abafb47d3e8cb4',
            replicatedPointers: ['/captures/0/cases/60/facts/cause', '/captures/1/cases/60/facts/cause'],
          },
          {
            id: 'scalar-60-3',
            pointer: '/captures/0/cases/60/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/60/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/60/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-61-0',
            pointer: '/captures/0/cases/61/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/61/facts/status', '/captures/1/cases/61/facts/status'],
          },
          {
            id: 'scalar-61-1',
            pointer: '/captures/0/cases/61/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/61/facts/code', '/captures/1/cases/61/facts/code'],
          },
          {
            id: 'scalar-61-2',
            pointer: '/captures/0/cases/61/facts/cause',
            sha256: '90fd385f4ad7f4f8d77b5948c02b2d418b9bfb1c67d0e48802abafb47d3e8cb4',
            replicatedPointers: ['/captures/0/cases/61/facts/cause', '/captures/1/cases/61/facts/cause'],
          },
          {
            id: 'scalar-61-3',
            pointer: '/captures/0/cases/61/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/61/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/61/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-62-0',
            pointer: '/captures/0/cases/62/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/62/facts/status', '/captures/1/cases/62/facts/status'],
          },
          {
            id: 'scalar-62-1',
            pointer: '/captures/0/cases/62/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/62/facts/code', '/captures/1/cases/62/facts/code'],
          },
          {
            id: 'scalar-62-2',
            pointer: '/captures/0/cases/62/facts/cause',
            sha256: '90fd385f4ad7f4f8d77b5948c02b2d418b9bfb1c67d0e48802abafb47d3e8cb4',
            replicatedPointers: ['/captures/0/cases/62/facts/cause', '/captures/1/cases/62/facts/cause'],
          },
          {
            id: 'scalar-62-3',
            pointer: '/captures/0/cases/62/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/62/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/62/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-63-0',
            pointer: '/captures/0/cases/63/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/63/facts/status', '/captures/1/cases/63/facts/status'],
          },
          {
            id: 'scalar-63-1',
            pointer: '/captures/0/cases/63/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/63/facts/code', '/captures/1/cases/63/facts/code'],
          },
          {
            id: 'scalar-63-2',
            pointer: '/captures/0/cases/63/facts/cause',
            sha256: '90fd385f4ad7f4f8d77b5948c02b2d418b9bfb1c67d0e48802abafb47d3e8cb4',
            replicatedPointers: ['/captures/0/cases/63/facts/cause', '/captures/1/cases/63/facts/cause'],
          },
          {
            id: 'scalar-63-3',
            pointer: '/captures/0/cases/63/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/63/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/63/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-64-0',
            pointer: '/captures/0/cases/64/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/64/facts/status', '/captures/1/cases/64/facts/status'],
          },
          {
            id: 'scalar-64-1',
            pointer: '/captures/0/cases/64/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/64/facts/code', '/captures/1/cases/64/facts/code'],
          },
          {
            id: 'scalar-64-2',
            pointer: '/captures/0/cases/64/facts/cause',
            sha256: '804f5042d845bbef8b5b0d8fb602326196e9cbb9b90dfc8d63253250f09f837c',
            replicatedPointers: ['/captures/0/cases/64/facts/cause', '/captures/1/cases/64/facts/cause'],
          },
          {
            id: 'scalar-64-3',
            pointer: '/captures/0/cases/64/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/64/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/64/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-65-0',
            pointer: '/captures/0/cases/65/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/65/facts/status', '/captures/1/cases/65/facts/status'],
          },
          {
            id: 'scalar-65-1',
            pointer: '/captures/0/cases/65/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/65/facts/code', '/captures/1/cases/65/facts/code'],
          },
          {
            id: 'scalar-65-2',
            pointer: '/captures/0/cases/65/facts/cause',
            sha256: '804f5042d845bbef8b5b0d8fb602326196e9cbb9b90dfc8d63253250f09f837c',
            replicatedPointers: ['/captures/0/cases/65/facts/cause', '/captures/1/cases/65/facts/cause'],
          },
          {
            id: 'scalar-65-3',
            pointer: '/captures/0/cases/65/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/65/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/65/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-66-0',
            pointer: '/captures/0/cases/66/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/66/facts/status', '/captures/1/cases/66/facts/status'],
          },
          {
            id: 'scalar-66-1',
            pointer: '/captures/0/cases/66/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/66/facts/code', '/captures/1/cases/66/facts/code'],
          },
          {
            id: 'scalar-66-2',
            pointer: '/captures/0/cases/66/facts/cause',
            sha256: '804f5042d845bbef8b5b0d8fb602326196e9cbb9b90dfc8d63253250f09f837c',
            replicatedPointers: ['/captures/0/cases/66/facts/cause', '/captures/1/cases/66/facts/cause'],
          },
          {
            id: 'scalar-66-3',
            pointer: '/captures/0/cases/66/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/66/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/66/facts/entityPositionMatchesRequestRole',
            ],
          },
          {
            id: 'scalar-67-0',
            pointer: '/captures/0/cases/67/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/67/facts/status', '/captures/1/cases/67/facts/status'],
          },
          {
            id: 'scalar-67-1',
            pointer: '/captures/0/cases/67/facts/code',
            sha256: '7601392142a256ed808751977f5407b5e35ece15c61240cfa7b995fa483bd1d0',
            replicatedPointers: ['/captures/0/cases/67/facts/code', '/captures/1/cases/67/facts/code'],
          },
          {
            id: 'scalar-67-2',
            pointer: '/captures/0/cases/67/facts/cause',
            sha256: '804f5042d845bbef8b5b0d8fb602326196e9cbb9b90dfc8d63253250f09f837c',
            replicatedPointers: ['/captures/0/cases/67/facts/cause', '/captures/1/cases/67/facts/cause'],
          },
          {
            id: 'scalar-67-3',
            pointer: '/captures/0/cases/67/facts/entityPositionMatchesRequestRole',
            sha256: 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
            replicatedPointers: [
              '/captures/0/cases/67/facts/entityPositionMatchesRequestRole',
              '/captures/1/cases/67/facts/entityPositionMatchesRequestRole',
            ],
          },
        ],
      },
    ],
  },
]);
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { webApiScalarReaderCases } from '../testing/webapi-contract.mjs';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { install, parseCustomApiFiles } from '../lib/dataverse-customapi.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { sourceOrganizationExtensions } from '../lib/source-organization-extensions.mjs';

const APP = '10000000-0000-4000-8000-000000000001',
  ID = '20000000-0000-4000-8000-000000000001';
const SECRET = 'PAQVILO_SCALAR_READER_TEST_SECRET';
const nativeCause = (literal, target, source) =>
  `Cannot convert the literal '${literal}' to the expected type '${target}'. ---> Microsoft.OData.ODataException: Cannot convert a value of type '${source}' to the expected target type '${target}'.`;
const nativeFormat = (literal, target, cause) =>
  `Cannot convert the literal '${literal}' to the expected type '${target}'. ---> System.FormatException: ${cause}`;

test('HTTP scalar errors retain native type/format causes and exact numeric tokens without inventing CLR stacks', async (t) => {
  const previous = process.env[SECRET];
  process.env[SECRET] = 'invented-loopback-secret';
  const state = emptyState();
  state.mappings.sample = {
    logicalName: 'sample',
    entitySet: 'samples',
    idColumn: 'sampleid',
    nameColumn: 'name',
    fields: {
      name: { dataverseType: 'nvarchar' },
      quantity: { dataverseType: 'int' },
      enabled: { dataverseType: 'bit' },
      amount: { dataverseType: 'decimal' },
      price: { dataverseType: 'money' },
      ratio: { dataverseType: 'float' },
      stamp: { dataverseType: 'datetime' },
      day: { dataverseType: 'datetime', dateTimeBehavior: 'DateOnly' },
      choice: { dataverseType: 'picklist' },
      tags: { dataverseType: 'multiselectpicklist' },
    },
  };
  state.tables.sample = [
    {
      sampleid: ID,
      name: 'Unchanged',
      quantity: 7,
      enabled: true,
      amount: 1.25,
      price: 2.5,
      ratio: 1.5,
      stamp: '2020-01-15T12:00:00Z',
      day: '2020-01-15',
      choice: 1,
      tags: '1',
    },
  ];
  const store = await new DataStore({ state }).init(),
    api = await startDataverseApi({
      store,
      change: (fn) => fn(),
      settings: dataverseSettings({
        enabled: true,
        applications: [
          {
            appId: APP,
            displayName: 'Invented reader client',
            secretEnvironmentVariable: SECRET,
            roles: ['System Administrator'],
          },
        ],
      }),
      log: () => {},
    });
  t.after(async () => {
    await api.close();
    if (previous === undefined) delete process.env[SECRET];
    else process.env[SECRET] = previous;
  });
  const auth = await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: APP,
      client_secret: process.env[SECRET],
      scope: `${api.origin}/.default`,
    }),
  });
  assert.equal(auth.status, 200);
  const token = (await auth.json()).access_token;
  const initial = JSON.stringify(store.state.tables.sample);
  const cases = webApiScalarReaderCases();
  const diagnostics = [];
  const encodedCases = cases.flatMap((entry, index) =>
    [
      ['plain', ''],
      ['UTF-8 BOM', '\uFEFF'],
    ].map(([encoding, prefix]) => [...entry, encoding, prefix, index]),
  );
  for (const [field, tokenText, cause, encoding, prefix, index] of encodedCases)
    for (const method of ['POST', 'PATCH'])
      // @test-kind parity: Each plain/BOM raw scalar POST/PATCH case reproduces a separately captured native400/code/cause and entity-set position; no CLR-stack absence claim is made here.
      // @parity-evidence: webapi-native-scalar-reader.json binds all68 exact authored inputs to two native raw-response hashes per case and the formatted shared producer SHA256.
      await t.test(`${encoding} ${method} ${field} ${tokenText}`, async () => {
        const nativeBytes = fs.readFileSync(new URL('./fixtures/webapi-native-scalar-reader.json', import.meta.url));
        assert.equal(
          createHash('sha256').update(nativeBytes).digest('hex'),
          'ca297cf7e3fd91a1ae9fd4a4b4e22eda260c517b384c7747bf71c295809e140b',
        );
        assert.equal(
          createHash('sha256')
            .update(fs.readFileSync(new URL('../testing/webapi-contract.mjs', import.meta.url)))
            .digest('hex'),
          '8d30332b553e45f62de42e317e853d0753f98864c062ab688398415e9a378b3a',
        );
        const nativeProof = JSON.parse(nativeBytes);
        const expected = nativeProof.cases.find(
          (entry) => entry.id === `reader.${index}.${prefix ? 'bom' : 'plain'}.${method}`,
        );
        assert.deepEqual(
          { field, token: tokenText, cause, encoding: prefix ? 'bom' : 'plain', method },
          {
            field: expected.field,
            token: expected.token,
            cause: expected.cause,
            encoding: expected.encoding,
            method: expected.method,
          },
        );
        const response = await fetch(
          api.origin + '/api/data/v9.2/' + (method === 'POST' ? 'samples' : `samples(${ID})`),
          {
            method,
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
            },
            body: prefix + `{"${field}":${tokenText}}`,
          },
        );
        assert.equal(response.status, expected.status);
        const error = (await response.json()).error;
        assert.equal(error.code, expected.code);
        assert.ok(error.message.includes(expected.cause), error.message);
        assert.ok(error.message.includes(method === 'POST' ? "Entity :'samples'" : "Entity :''"));
        diagnostics.push(error.message);
      });
  // @test-kind parity: The complete original17-by-two-encoding-by-two-method scalar universe must execute; source-loop edits cannot silently skip native guarantees.
  // @parity-evidence: webapi-native-scalar-reader.json protects all68 repeated native cases and the exact shared authored producer bytes.
  await t.test('all68 original native scalar cases execute', () => {
    assert.equal(diagnostics.length, 68);
    assert.equal(
      createHash('sha256')
        .update(fs.readFileSync(new URL('./fixtures/webapi-native-scalar-reader.json', import.meta.url)))
        .digest('hex'),
      'ca297cf7e3fd91a1ae9fd4a4b4e22eda260c517b384c7747bf71c295809e140b',
    );
    assert.equal(
      createHash('sha256')
        .update(fs.readFileSync(new URL('../testing/webapi-contract.mjs', import.meta.url)))
        .digest('hex'),
      '8d30332b553e45f62de42e317e853d0753f98864c062ab688398415e9a378b3a',
    );
  });
  assert.ok(
    diagnostics.every((message) => !message.includes('   at ')),
    'default local diagnostic mode does not fabricate CLR stack frames',
  );
  for (const prefix of ['', '\uFEFF']) {
    const response = await fetch(api.origin + '/api/data/v9.2/samples(20000000-0000-4000-8000-000000000099)', {
      method: 'PATCH',
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
        'if-match': '*',
      },
      body: prefix + '{"quantity":1}',
    });
    assert.equal(response.status, 404, 'Valid JSON reaches the update-only missing-record check with or without a BOM');
  }
  assert.equal(JSON.stringify(store.state.tables.sample), initial, 'all failed HTTP conversions are nonmutating');
  assert.throws(
    () => store.coerceRecord(store.state.mappings.sample, { name: false }, { dataverseWebApi: true }),
    (e) =>
      e.message.includes("'false'") && !e.message.includes('InnerException') && !e.message.includes("Edm.Boolean' to"),
  );
  assert.throws(
    () => store.coerceRecord(store.state.mappings.sample, { quantity: 'bad' }, { coerce: true }),
    (e) => !e.message.includes('InnerException') && !e.message.includes('System.FormatException'),
  );
});

test('custom API actions obtain scalar causes through the actual HTTP transport', async (t) => {
  const variable = 'PAQVILO_CUSTOM_SCALAR_READER_TEST_SECRET';
  process.env[variable] = 'Invented custom reader secret';
  t.after(() => delete process.env[variable]);
  const state = emptyState(),
    files = [
      {
        path: 'sample_Check/customapi.xml',
        text: '<customapi uniquename="sample_Check"><bindingtype>0</bindingtype><isfunction>0</isfunction></customapi>',
      },
      ...Object.entries({ Count: 7, Flag: 0, Name: 10, Labels: 11 }).map(([name, type]) => ({
        path: `sample_Check/customapirequestparameters/${name}/customapirequestparameter.xml`,
        text: `<customapirequestparameter uniquename="${name}"><type>${type}</type><isoptional>1</isoptional></customapirequestparameter>`,
      })),
    ];
  Object.assign(state.tables, parseCustomApiFiles(files));
  const store = await new DataStore({ state }).init();
  let calls = 0;
  const extensions = await sourceOrganizationExtensions({
    customApis: new Map([
      [
        'sample_check',
        {
          handler: async () => {
            calls++;
            return { outputs: {} };
          },
        },
      ],
    ]),
  });
  const organization = await createOrganizationRuntime({
    store,
    extensions,
    settings: dataverseSettings({
      enabled: true,
      applications: [
        {
          appId: APP,
          displayName: 'Invented custom reader',
          secretEnvironmentVariable: variable,
          roles: ['System Administrator'],
        },
      ],
    }),
  });
  t.after(() => organization.close());
  const transport = await startDataverseApi({ organization });
  t.after(() => transport.close());
  const tokenResponse = await fetch(transport.authority + '/oauth2/v2.0/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: APP,
      client_secret: process.env[variable],
      scope: transport.origin + '/.default',
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const token = (await tokenResponse.json()).access_token;
  for (const [body, cause, prefix] of [
    [{ Count: 'bad' }, nativeFormat('bad', 'Edm.Int32', 'Input string was not in a correct format.')],
    [{ Flag: 1 }, nativeCause('1', 'Edm.Boolean', 'Edm.Int32')],
    [{ Name: false }, nativeCause('False', 'Edm.String', 'Edm.Boolean')],
    [{ Labels: ['valid', 1] }, nativeCause('1', 'Edm.String', 'Edm.Int32')],
  ].flatMap((entry) => ['', '\uFEFF'].map((prefix) => [...entry, prefix]))) {
    const response = await fetch(transport.origin + '/api/data/v9.2/sample_Check', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: prefix + JSON.stringify(body),
    });
    assert.equal(response.status, 400);
    const message = (await response.json()).error.message;
    assert.ok(message.includes(cause), message);
  }
  assert.equal(calls, 0, 'invalid parameters never execute custom logic');
});

test('custom API internal callers retain original diagnostics while the actual HTTP reader carries native causes', async () => {
  const files = [
    {
      path: 'sample_Action/customapi.xml',
      text: '<customapi uniquename="sample_Action"><bindingtype>0</bindingtype><isfunction>0</isfunction></customapi>',
    },
    ...Object.entries({ Count: 7, Flag: 0, Name: 10, Labels: 11 }).map(([name, type]) => ({
      path: `sample_Action/customapirequestparameters/${name}/customapirequestparameter.xml`,
      text: `<customapirequestparameter uniquename="${name}"><type>${type}</type><isoptional>1</isoptional></customapirequestparameter>`,
    })),
  ];
  const state = emptyState(),
    rows = parseCustomApiFiles(files);
  Object.assign(state.tables, rows);
  const store = new DataStore({ state }),
    ops = [];
  // Awaited: install also queues its seeding transaction, which must not outlive the test.
  await install({
    store,
    change: (fn) => fn(),
    registry: { register: (op) => ops.push(op), has: () => false },
    principals: { privileges: () => new Map() },
  }).ready;
  const op = ops.find((op) => op.name === 'sample_Action');
  assert.ok(op);
  for (const [body, fragment] of [
    [{ Count: 'bad' }, 'System.FormatException'],
    [{ Flag: 1 }, "type 'Edm.Int32'"],
    [{ Name: false }, "literal 'False'"],
    [{ Labels: ['valid', 1] }, "type 'Edm.Int32'"],
  ]) {
    const context = {
      method: 'POST',
      body,
      url: new URL('http://127.0.0.1/api/data/v9.2/sample_Action'),
      user: { systemuserid: ID },
      origin: 'http://127.0.0.1',
      version: 'v9.2',
    };
    await assert.rejects(
      () => op.handle(context),
      (e) => e.status === 400 && !e.message.includes('System.FormatException') && !e.message.includes(' ---> '),
    );
    // This marker is produced only by the real Dataverse HTTP transport. The
    // end-to-end record test above independently verifies that boundary.
    const source = JSON.stringify(body);
    context.dataverseHttpReader = {
      hasJsonBody: true,
      ieee754Compatible: false,
      numberLexemeFor: () => (source.includes(':1') || source.includes(',1') ? '1' : undefined),
    };
    await assert.rejects(
      () => op.handle(context),
      (e) => e.status === 400 && e.message.includes(fragment) && !e.message.includes('   at '),
    );
    for (const [method, hasJsonBody] of [
      ['POST', false],
      ['GET', false],
      ['GET', true],
    ]) {
      // A URI function or a non-JSON caller has no qualified JSON-reader cause,
      // even if an HTTP transport marker is present.
      store.state.tables.customapi[0].isfunction = method === 'GET';
      await assert.rejects(
        () =>
          op.handle({
            ...context,
            method,
            ...(method === 'GET' ? { body: undefined, params: body } : {}),
            dataverseHttpReader: { ...context.dataverseHttpReader, hasJsonBody },
          }),
        (error) =>
          error.status === 400 &&
          !error.message.includes('System.FormatException') &&
          !error.message.includes(' ---> '),
      );
      store.state.tables.customapi[0].isfunction = false;
    }
  }
});
